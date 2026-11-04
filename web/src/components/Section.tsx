import type { ReactNode } from "react";

/**
 * A page section: a heading, anything that sits beside it, then the content.
 * `id` goes on the heading and labels the section with it. `className` adds to `section`.
 */
export function Section({ id, className, title, aside, children }: {
  id?: string;
  className?: string;
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={className ? `section ${className}` : "section"} aria-labelledby={id}>
      <div className="section-head">
        <h2 className="section-title" id={id}>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
