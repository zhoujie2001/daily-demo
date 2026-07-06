import React from 'react';
import { books } from '../data/books';

export default function Reading() {
  return (
    <section id="reading">
      <h2>Reading_favorite</h2>
      <div className="div_books">
        <ul className="hanging-list">
          {books.map((book) => (
            <li key={`${book.title}-${book.year}`}>
              <span className="year">{book.year}</span>《{book.title}》
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
