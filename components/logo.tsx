import Image from 'next/image';
import wordmark from '@/public/brand/long-wordmark.png';
import { APP_NAME } from '@/lib/shared/brand';

/** The "long" wordmark, cut out of the navy logo so it sits on any of the site's navy bands. Size it by height. */
export function Wordmark({ className = 'h-8', priority = false }: { className?: string; priority?: boolean }) {
  return <Image src={wordmark} alt={APP_NAME} priority={priority} className={`w-auto ${className}`} />;
}
