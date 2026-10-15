// Preloaded into a QA-only EV server (node --import) so simulated weeks can
// pass in minutes. Shifts every Date the process creates by EV_QA_TIME_OFFSET_MS;
// timers still run in real time. Never loaded by the product itself.
const offset = Number(process.env.EV_QA_TIME_OFFSET_MS ?? 0);

if (Number.isFinite(offset) && offset !== 0) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() { return RealDate.now() + offset; }
  }
  globalThis.Date = ShiftedDate;
}
