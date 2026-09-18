import { ShieldCheck } from 'lucide-react';

export default function Brand({ onDark = false }: { onDark?: boolean }) {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">
        <ShieldCheck size={18} />
      </div>
      <span className={'brand-word' + (onDark ? ' on-dark' : '')}>Paywai</span>
    </div>
  );
}