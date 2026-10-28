class CubicSpline {
  // control times
  times: number[];

  // control data: in-tangent, point, out-tangent
  knots: number[];

  // dimension of the knot points
  dim: number;

  // For looping splines built via fromPointsLooping, the original keyframe at
  // index i lives at spline segment i+2 (due to two ghost entries prepended).
  // Pass this offset to evaluateSegment when you already know the keyframe index.
  readonly keyframeOffset: number;

  constructor(times: number[], knots: number[], keyframeOffset = 0) {
    this.times = times;
    this.knots = knots;
    this.dim = knots.length / times.length / 3;
    this.keyframeOffset = keyframeOffset;
  }

  evaluate(time: number, result: number[]) {
    const { times } = this;
    const last = times.length - 1;

    if (time <= times[0]) {
      this.getKnot(0, result);
    } else if (time >= times[last]) {
      this.getKnot(last, result);
    } else {
      // Binary search: find largest seg where times[seg] <= time.
      let lo = 0, hi = last - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (time >= times[mid]) lo = mid;
        else hi = mid - 1;
      }
      this.evaluateSegment(
        lo,
        (time - times[lo]) / (times[lo + 1] - times[lo]),
        result,
      );
    }
  }

  getKnot(index: number, result: number[]) {
    const { knots, dim } = this;
    const idx = index * 3 * dim;
    for (let i = 0; i < dim; ++i) {
      result[i] = knots[idx + i * 3 + 1];
    }
  }

  evaluateSegment(segment: number, t: number, result: number[]) {
    const { knots, dim } = this;

    const t2 = t * t;
    const twot = t + t;
    const omt = 1 - t;
    const omt2 = omt * omt;

    let idx = segment * dim * 3;
    for (let i = 0; i < dim; ++i) {
      const p0 = knots[idx + 1];
      const m0 = knots[idx + 2];
      const m1 = knots[idx + dim * 3];
      const p1 = knots[idx + dim * 3 + 1];
      idx += 3;

      result[i] =
        p0 * ((1 + twot) * omt2) +
        m0 * (t * omt2) +
        p1 * (t2 * (3 - twot)) +
        m1 * (t2 * (t - 1));
    }
  }

  static calcKnots(times: number[], points: number[], smoothness: number) {
    const n = times.length;
    const dim = points.length / n;
    const knots: number[] = Array.from({ length: n * dim * 3 });

    for (let i = 0; i < n; i++) {
      const t = times[i];

      for (let j = 0; j < dim; j++) {
        const idx = i * dim + j;
        const p = points[idx];

        let tangent;
        if (i === 0) {
          tangent = (points[idx + dim] - p) / (times[i + 1] - t);
        } else if (i === n - 1) {
          tangent = (p - points[idx - dim]) / (t - times[i - 1]);
        } else {
          tangent =
            (points[idx + dim] - points[idx - dim]) /
            (times[i + 1] - times[i - 1]);
        }

        const inScale = i > 0 ? times[i] - times[i - 1] : times[1] - times[0];
        const outScale =
          i < n - 1 ? times[i + 1] - times[i] : times[i] - times[i - 1];

        knots[idx * 3] = tangent * inScale * smoothness;
        knots[idx * 3 + 1] = p;
        knots[idx * 3 + 2] = tangent * outScale * smoothness;
      }
    }

    return knots;
  }

  static fromPoints(times: number[], points: number[], smoothness = 1) {
    return new CubicSpline(
      times,
      CubicSpline.calcKnots(times, points, smoothness),
      0,
    );
  }

  static fromPointsLooping(
    length: number,
    times: number[],
    points: number[],
    smoothness = 1,
  ) {
    if (times.length < 2) {
      return CubicSpline.fromPoints(times, points);
    }

    const dim = points.length / times.length;
    const newTimes = times.slice();
    const newPoints = points.slice();

    newTimes.push(length + times[0], length + times[1]);
    newPoints.push(...points.slice(0, dim * 2));

    newTimes.splice(
      0,
      0,
      times[times.length - 2] - length,
      times[times.length - 1] - length,
    );
    newPoints.splice(0, 0, ...points.slice(points.length - dim * 2));

    // keyframeOffset=2: two ghost entries are prepended, so keyframe[i] lives
    // at spline segment i+2. Callers that know the keyframe index can skip the
    // segment search by calling evaluateSegment(i + 2, t, result) directly.
    return new CubicSpline(
      newTimes,
      CubicSpline.calcKnots(newTimes, newPoints, smoothness),
      2,
    );
  }
}

export { CubicSpline };
