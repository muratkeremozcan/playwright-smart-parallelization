'use strict';

/**
 * Preload that moves the clock of a process `PSP_DATE_SHIFT_DAYS` days ahead: `Date.now()` and
 * `new Date()` report the shifted time, while a `Date` built from a value keeps that value. The
 * history experiments run `update` under it to see what the package does with old entries.
 */

const shift = Number(process.env.PSP_DATE_SHIFT_DAYS || 0) * 86400000;
const RealDate = Date;

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + shift);
    else super(...args);
  }

  static now() {
    return RealDate.now() + shift;
  }
}

globalThis.Date = ShiftedDate;
