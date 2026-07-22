import React from 'react';
import { ExternalLink, Mail } from 'lucide-react';
import { contactEmail, externalLinks } from '../data/links';
import SectionHeading from './ui/SectionHeading';

export default function Links() {
  return (
    <section id="links" className="links-section">
      <SectionHeading
        index="06"
        title="Links"
        description="在网络的其他角落，也可以找到我。"
      />
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
