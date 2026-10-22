import { ImageResponse } from 'takumi-js/response';
import { Mark } from './_components/mark';

export default function AppleIcon() {
  return new ImageResponse(<Mark size={180} />, { width: 180, height: 180 });
}
