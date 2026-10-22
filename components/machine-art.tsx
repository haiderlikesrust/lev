/* eslint-disable @next/next/no-img-element -- Collector Crypt's own CDN images, shown as-is. */
import { PokeBall } from './pokeball';

/** A Collector Crypt machine's own art (transparent PNG), or a Poké Ball while it loads. */
export function MachineArt({ image, name, className = '' }: { image: string | null | undefined; name: string; className?: string }) {
  if (!image) return <div className={`flex items-center justify-center ${className}`}><PokeBall size={56} className="opacity-80" /></div>;
  return <img src={image} alt={`${name} machine`} loading="lazy" className={`object-contain drop-shadow-[0_18px_22px_rgba(16,20,58,0.28)] ${className}`} />;
}

/** A card photo from Collector Crypt, with a soft placeholder. */
export function CardPhoto({ image, name, className = '' }: { image: string | null | undefined; name?: string | null; className?: string }) {
  if (!image) return <div className={`flex items-center justify-center rounded-xl bg-mist ${className}`}><PokeBall size={28} className="opacity-60" /></div>;
  return <img src={image} alt={name ?? 'Card'} loading="lazy" className={`rounded-xl object-cover ${className}`} />;
}
