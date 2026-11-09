import { describe, expect, it } from 'vitest';
import { cropRegion } from './capture';

const corners = [
  { x: 100, y: 100 },
  { x: 200, y: 100 },
  { x: 200, y: 200 },
  { x: 100, y: 200 },
];

describe('cropRegion', () => {
  it('adds a margin around the code', () => {
    expect(cropRegion(corners, 1000, 1000)).toEqual({ x: 86, y: 86, width: 128, height: 128 });
  });

  it('stays inside the frame when the code touches an edge', () => {
    const region = cropRegion(corners, 205, 205);
    expect(region.x + region.width).toBe(205);
    expect(region.y + region.height).toBe(205);
    const topLeft = cropRegion(corners.map((p) => ({ x: p.x - 100, y: p.y - 100 })), 1000, 1000);
    expect(topLeft.x).toBe(0);
    expect(topLeft.y).toBe(0);
  });

  it('covers a tilted code entirely', () => {
    const tilted = [
      { x: 150, y: 50 },
      { x: 250, y: 150 },
      { x: 150, y: 250 },
      { x: 50, y: 150 },
    ];
    const region = cropRegion(tilted, 1000, 1000);
    expect(region.x).toBeLessThan(50);
    expect(region.y).toBeLessThan(50);
    expect(region.x + region.width).toBeGreaterThan(250);
    expect(region.y + region.height).toBeGreaterThan(250);
  });
});
