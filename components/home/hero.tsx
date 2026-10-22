'use client';
import Link from 'next/link';
import { ArrowRight, BookOpen } from 'lucide-react';
import { useHomeData } from './home-data';
import { MachineArt } from '../machine-art';
import { HighRisk } from '../ui';

/** Dark hero with CC's real machines floating on the right. */
export function Hero() {
  const { config } = useHomeData();
  const art = (code: string) => config?.machines.find(m => m.code === code);
  const center = art('pokemon_100'), left = art('pokemon_25'), right = art('pokemon_250');
  return (
    <section className="dots relative overflow-hidden rounded-[2rem] bg-navy text-white">
      <div className="hero-glow absolute inset-0" />
      <div className="relative grid items-center gap-8 px-6 py-10 sm:px-10 sm:py-14 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <HighRisk />
          <h1 className="mt-5 text-4xl font-extrabold leading-[1.05] sm:text-6xl">
            Leverage your next <span className="text-poke-yellow">Collector Crypt</span> pull.
          </h1>
          <p className="mt-5 max-w-lg text-base text-white/75 sm:text-lg">
            Beat the pack price and the pool pays you a bonus on top of your card. Miss it, and the pool keeps the card. Optional, honest odds, and you can lose your entire pack price.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/open" className="inline-flex h-12 items-center gap-2 rounded-full bg-poke-red px-6 font-semibold text-white shadow-lg shadow-poke-red/30 transition hover:bg-poke-red-dark">
              Choose a machine <ArrowRight size={18} />
            </Link>
            <Link href="/docs" className="inline-flex h-12 items-center gap-2 rounded-full bg-white/10 px-6 font-semibold text-white ring-1 ring-white/20 transition hover:bg-white/15">
              <BookOpen size={18} /> How it works
            </Link>
          </div>
        </div>

        <div className="relative mx-auto h-64 w-full max-w-md sm:h-80">
          <div className="absolute left-1/2 top-1/2 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-poke-yellow/25 blur-2xl sm:h-72 sm:w-72" />
          <MachineArt image={left?.image} name="Starter" className="float absolute bottom-2 left-0 h-36 w-28 opacity-90 sm:h-44 sm:w-32 [animation-delay:-1.5s]" />
          <MachineArt image={right?.image} name="Legendary" className="float absolute bottom-2 right-0 h-36 w-28 opacity-90 sm:h-44 sm:w-32 [animation-delay:-3s]" />
          <MachineArt image={center?.image} name="Bronze" className="float absolute left-1/2 top-0 h-60 w-44 -translate-x-1/2 sm:h-72 sm:w-52" />
          <Chip className="left-0 top-4 sm:-left-2" dot="bg-poke-yellow" text="Win · card + bonus" />
          <Chip className="right-0 top-20 sm:-right-2" dot="bg-white/60" text="Push · the card" />
          <Chip className="bottom-0 left-1/2 -translate-x-1/2" dot="bg-poke-red" text="Loss · sold back" />
        </div>
      </div>
    </section>
  );
}

function Chip({ className, dot, text }: { className: string; dot: string; text: string }) {
  return (
    <span className={`absolute z-10 inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-white/95 px-3 py-1.5 text-xs font-semibold text-ink shadow-lg ${className}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />{text}
    </span>
  );
}
