// Demo clock. The sample history covers the months up to today, so early in a
// month the History page would open on an almost empty calendar. In the first
// 20 days of a month the demo runs two days before the end of last month
// instead, at the real time of day, so "this month" is always full of data.
// Only the demo (`npm run dev:ui`, `vite --mode mock`) loads this file.
const RealDate = Date;
const real = new RealDate();
let offset = 0;
if (real.getDate() <= 20) {
  const shifted = new RealDate(real.getFullYear(), real.getMonth(), 0); // last day of last month
  shifted.setDate(shifted.getDate() - 1);
  shifted.setHours(real.getHours(), real.getMinutes(), real.getSeconds(), real.getMilliseconds());
  offset = shifted.getTime() - real.getTime();
}

if (offset !== 0) {
  class DemoDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [any]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  (globalThis as any).Date = DemoDate;
}

export {};
