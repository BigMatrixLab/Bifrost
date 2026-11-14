//! City-level location of public IP addresses, for the Network globe.
//!
//! The address is sent over HTTPS to ipinfo.io (or ipwho.is if that fails).
//! Only public addresses are looked up, never private or carrier-grade NAT
//! ones, and only while Settings → Privacy → "Show devices on the map" is on.
//! Results are cached in memory: a day for a location, ten minutes for a
//! failed lookup, so the services see each address about once a day.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use iroh::Endpoint;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tracing::debug;

const FOUND_TTL: Duration = Duration::from_secs(24 * 3600);
const FAILED_TTL: Duration = Duration::from_secs(10 * 60);
const TIMEOUT: Duration = Duration::from_secs(10);

/// Where an IP address is, as the lookup service places it (city level).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoLoc {
    pub lat: f64,
    pub lon: f64,
    pub city: String,
    pub region: String,
    /// Country name or ISO code, as the service returns it.
    pub country: String,
}

/// A device's public IP for the map: the public address of a direct path,
/// else the one it reported for itself. None while map locations are off.
pub fn peer_public_ip(inner: &crate::inner::Inner, peer: &iroh::EndpointId, route: &crate::types::RouteInfo) -> Option<String> {
    if !inner.settings.read().map_locations {
        return None;
    }
    crate::net::route_public_ip(route)
        .or_else(|| inner.peer_ips.lock().get(peer).copied())
        .map(|ip| ip.to_string())
}

/// This device's public IP to tell paired devices, if map locations are on.
pub fn own_shared_ip(inner: &crate::inner::Inner) -> Option<String> {
    if !inner.settings.read().map_locations {
        return None;
    }
    crate::net::own_public_ip(&inner.endpoint).map(|ip| ip.to_string())
}

/// Keeps the public IP a device reported for itself; anything that isn't a
/// public address is dropped. Returns true if it changed.
pub fn record_peer_ip(inner: &crate::inner::Inner, peer: iroh::EndpointId, ip: Option<&str>) -> bool {
    let ip = ip
        .and_then(|s| s.parse::<IpAddr>().ok())
        .map(|ip| ip.to_canonical())
        .filter(|ip| crate::net::ip_scope(*ip) == "public");
    let mut map = inner.peer_ips.lock();
    match ip {
        Some(ip) => map.insert(peer, ip) != Some(ip),
        None => map.remove(&peer).is_some(),
    }
}

/// Tells the sender this device's public IP and keeps the one it answers
/// with. Once per connection; older senders don't answer, which is fine.
pub async fn exchange_addr(inner: std::sync::Arc<crate::inner::Inner>, conn: iroh::endpoint::Connection) {
    use crate::proto::{Request, Response};
    // The relays report this device's public address a few seconds after start.
    for _ in 0..10 {
        if crate::net::own_public_ip(&inner.endpoint).is_some() || !inner.settings.read().map_locations {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let req = Request::Addr { ip: own_shared_ip(&inner) };
    match tokio::time::timeout(Duration::from_secs(30), crate::receiver::request(&conn, &req)).await {
        Ok(Ok(Response::Addr { ip })) => {
            if record_peer_ip(&inner, conn.remote_id(), ip.as_deref()) {
                crate::receiver::refresh_peer_status(&inner, conn.remote_id());
            }
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => debug!("geo: address exchange failed: {e}"),
        Err(_) => debug!("geo: address exchange timed out"),
    }
}

#[derive(Default)]
pub struct GeoCache {
    client: Mutex<Option<reqwest::Client>>,
    entries: Mutex<HashMap<IpAddr, (Option<GeoLoc>, Instant)>>,
    /// One lookup at a time, so the same address isn't fetched twice at once.
    busy: tokio::sync::Mutex<()>,
}

impl GeoCache {
    fn cached(&self, ip: IpAddr) -> Option<Option<GeoLoc>> {
        let map = self.entries.lock();
        let (loc, at) = map.get(&ip)?;
        let ttl = if loc.is_some() { FOUND_TTL } else { FAILED_TTL };
        (at.elapsed() < ttl).then(|| loc.clone())
    }

    fn client(&self, endpoint: &Endpoint) -> Option<reqwest::Client> {
        let mut c = self.client.lock();
        if c.is_none() {
            // Same TLS setup (crypto provider and trust anchors) iroh uses for
            // its own HTTPS requests.
            match reqwest::Client::builder()
                .tls_backend_preconfigured(endpoint.tls_config().clone())
                .timeout(TIMEOUT)
                .user_agent(concat!("Bifrost/", env!("CARGO_PKG_VERSION")))
                .build()
            {
                Ok(client) => *c = Some(client),
                Err(e) => debug!("geo: no HTTP client: {e}"),
            }
        }
        c.clone()
    }

    /// Location of a public IP address, or `None` if it isn't public or the
    /// lookup failed.
    pub async fn lookup(&self, endpoint: &Endpoint, ip: IpAddr) -> Option<GeoLoc> {
        if crate::net::ip_scope(ip) != "public" {
            return None;
        }
        if let Some(hit) = self.cached(ip) {
            return hit;
        }
        let _one = self.busy.lock().await;
        if let Some(hit) = self.cached(ip) {
            return hit;
        }
        let client = self.client(endpoint)?;
        let mut loc = None;
        for (url, parse) in [
            (format!("https://ipinfo.io/{ip}/json"), parse_ipinfo as fn(&Value) -> Option<GeoLoc>),
            (format!("https://ipwho.is/{ip}"), parse_ipwho),
        ] {
            match fetch(&client, &url).await {
                Ok(v) => {
                    loc = parse(&v);
                    if loc.is_some() {
                        break;
                    }
                    debug!("geo: no location in the answer from {url}");
                }
                Err(e) => debug!("geo: {url} failed: {e}"),
            }
        }
        self.entries.lock().insert(ip, (loc.clone(), Instant::now()));
        loc
    }
}

async fn fetch(client: &reqwest::Client, url: &str) -> anyhow::Result<Value> {
    let resp = client.get(url).header("Accept", "application/json").send().await?.error_for_status()?;
    let body = resp.bytes().await?;
    if body.len() > 64 * 1024 {
        anyhow::bail!("answer too large");
    }
    Ok(serde_json::from_slice(&body)?)
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().trim().chars().take(80).collect()
}

fn checked(lat: f64, lon: f64, v: &Value, country_key: &str) -> Option<GeoLoc> {
    let valid = lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0 && (lat, lon) != (0.0, 0.0);
    valid.then(|| GeoLoc { lat, lon, city: text(v, "city"), region: text(v, "region"), country: text(v, country_key) })
}

/// `{"city":"Dhaka","region":"Dhaka Division","country":"BD","loc":"23.7104,90.4074"}`
fn parse_ipinfo(v: &Value) -> Option<GeoLoc> {
    if v.get("bogon").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let (lat, lon) = v.get("loc")?.as_str()?.split_once(',')?;
    checked(lat.trim().parse().ok()?, lon.trim().parse().ok()?, v, "country")
}

/// `{"success":true,"city":"Dhaka","region":"Dhaka Division","country":"Bangladesh","latitude":23.7,"longitude":90.4}`
fn parse_ipwho(v: &Value) -> Option<GeoLoc> {
    if v.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    checked(v.get("latitude")?.as_f64()?, v.get("longitude")?.as_f64()?, v, "country")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_services() {
        let a: Value = serde_json::from_str(r#"{"ip":"8.8.8.8","city":"Mountain View","region":"California","country":"US","loc":"37.4056,-122.0775"}"#).unwrap();
        let l = parse_ipinfo(&a).unwrap();
        assert_eq!((l.lat, l.lon, l.city.as_str(), l.country.as_str()), (37.4056, -122.0775, "Mountain View", "US"));
        let b: Value = serde_json::from_str(r#"{"success":true,"city":"San Jose","region":"California","country":"United States","latitude":37.33,"longitude":-121.89}"#).unwrap();
        assert_eq!(parse_ipwho(&b).unwrap().country, "United States");
        assert!(parse_ipinfo(&serde_json::from_str(r#"{"ip":"10.0.0.1","bogon":true}"#).unwrap()).is_none());
        assert!(parse_ipwho(&serde_json::from_str(r#"{"success":false,"message":"Invalid IP address"}"#).unwrap()).is_none());
    }
}
