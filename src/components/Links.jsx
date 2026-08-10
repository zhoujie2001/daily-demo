import React from 'react';
import { ExternalLink, Mail } from 'lucide-react';
import { contactEmail, externalLinks } from '../data/links';
import SectionHeading from './ui/SectionHeading';

export default function Links() {
  return (
    <section id="links" className="links-section">
      <SectionHeading
        title="Links"
        description="在网络的其他角落，也可以找到我。"
      />
      <ul className="links" data-pet-avoid>
        <li>
          <a href={`mailto:${contactEmail}`}>
            <Mail size={16} aria-hidden="true" />
            <span>{contactEmail}</span>
          </a>
        </li>
        {externalLinks.map((link) => (
          <li key={link.href}>
            <a href={link.href} target="_blank" rel="noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              <span>{link.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
