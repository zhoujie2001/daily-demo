import React from 'react';
import { ArrowUp } from 'lucide-react';
import { siteBrand } from '../data/site';

export default function BrandFooter() {
  const returnToTop = (event) => {
    event.preventDefault();
    document.getElementById('about')?.scrollIntoView({ behavior: 'smooth' });
    window.history.replaceState(null, '', '#about');
  };

  return (
    <footer className="brand-footer" aria-label="网站信息" data-pet-avoid>
      <div className="brand-footer-copy">
        <p className="brand-footer-name">{siteBrand.name}</p>
        <p className="brand-footer-line">把普通日子收进时间里。</p>
      </div>

      <a className="brand-footer-return" href="#about" onClick={returnToTop}>
        <span>回到开头</span>
        <ArrowUp size={15} strokeWidth={1.7} aria-hidden="true" />
      </a>

      <p className="brand-footer-meta">
        © {new Date().getFullYear()} {siteBrand.ownerAlias} · 成都
      </p>
    </footer>
  );
}
