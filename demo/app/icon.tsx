import { ImageResponse } from 'takumi-js/response';
import { Mark } from './_components/mark';

export default function Icon() {
  return new ImageResponse(<Mark size={64} />, { width: 64, height: 64 });
}
