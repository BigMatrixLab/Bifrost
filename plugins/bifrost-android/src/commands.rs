use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::{BifrostAndroidExt, Result};

#[command]
pub(crate) async fn has_all_files_access<R: Runtime>(app: AppHandle<R>) -> Result<Granted> {
    app.bifrost_android().has_all_files_access()
}

#[command]
pub(crate) async fn request_all_files_access<R: Runtime>(app: AppHandle<R>) -> Result<Granted> {
    app.bifrost_android().request_all_files_access()
}

#[command]
pub(crate) async fn device_info<R: Runtime>(app: AppHandle<R>) -> Result<DeviceInfo> {
    app.bifrost_android().device_info()
}

#[command]
pub(crate) async fn request_notification_permission<R: Runtime>(app: AppHandle<R>) -> Result<Granted> {
    app.bifrost_android().request_notification_permission()
}

#[command]
pub(crate) async fn battery_status<R: Runtime>(app: AppHandle<R>) -> Result<BatteryStatus> {
    app.bifrost_android().battery_status()
}

#[command]
pub(crate) async fn request_ignore_battery_optimizations<R: Runtime>(app: AppHandle<R>) -> Result<BatteryStatus> {
    app.bifrost_android().request_ignore_battery_optimizations()
}

#[command]
pub(crate) async fn open_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<()> {
    app.bifrost_android().open_file(path)
}
