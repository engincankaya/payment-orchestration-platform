import { timingSafeEqual } from 'crypto';

export default function timingSafeEquals(left?: string, right?: string) {
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  // crypto.timingSafeEqual throws on length mismatch; auth should fail closed instead.
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
