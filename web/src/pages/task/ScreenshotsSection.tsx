import type { Task } from "@crane/contracts";
import { Section } from "../../components/Section";

export function ScreenshotsSection({ task }: { task: Task }) {
  const screenshots = task.report?.screenshots;
  if (!screenshots?.length) return null;
  return (
    <Section id="screenshots" title={<>Screenshots <span className="count">{screenshots.length}</span></>}>
      <div className="task-screenshots">
        {screenshots.map((image) => {
          const url = `/api/tasks/${encodeURIComponent(task.id)}/screenshots/${encodeURIComponent(image.path)}`;
          return (
            <figure className="card" key={image.path}>
              <a href={url} target="_blank" rel="noreferrer" aria-label={`Open screenshot: ${image.caption}`}>
                <img src={url} alt={image.caption} loading="lazy" />
              </a>
              <figcaption>{image.caption}</figcaption>
            </figure>
          );
        })}
      </div>
    </Section>
  );
}
