import React from 'react';
import { ExternalLink, Mail } from 'lucide-react';
import { contactEmail, externalLinks } from '../data/links';

export default function Links() {
  return (
    <section id="links">
      <h2>Links</h2>
      <ul className="links">
        <li>
          <Mail size={16} />
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
        </li>
        {externalLinks.map((link) => (
          <li key={link.href}>
            <ExternalLink size={16} />
            <a href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
