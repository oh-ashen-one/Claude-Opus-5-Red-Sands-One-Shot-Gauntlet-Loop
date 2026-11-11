// Time-of-day controller. Sunset is the hero look; every system reads from here.
export function createTimeOfDay(t = 0.726) {
  return {
    t,                       // 0..1 across a day: .25 sunrise, .5 noon, .75 sunset, 0 midnight
    speed: 0.0,              // frozen by default; quests drive it
    sunAltitude: 0, sunAzimuth: 0,
    update(dt) {
      this.t = (this.t + this.speed * dt) % 1;
      const a = (this.t - 0.25) * Math.PI * 2;
      this.sunAltitude = Math.sin(a) * 90;
      this.sunAzimuth = (this.t * 360 + 90) % 360;
    },
  };
}
