import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { Button } from './Button';
import { Stack } from './Stack';
import { Text } from './Text';

type Loader = () => Promise<unknown>;

/** A whole-page message: empty states, failures, and pages that do not exist. */
export function Notice({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <main className="al-center">
      <Stack gap={3} align="center">
        <Text variant="heading" as="h1">
          {title}
        </Text>
        {detail ? <Text tone="muted">{detail}</Text> : null}
        {action}
      </Stack>
    </main>
  );
}

export function Loading() {
  return (
    <div className="al-center al-loading" role="status">
      <Text tone="muted">Loading</Text>
    </div>
  );
}

/** Finds the first glob match whose file name, without extension, appears in `names`. */
function pick(modules: Record<string, Loader>, names: string[]): Loader | undefined {
  const paths = Object.keys(modules);
  for (const name of names) {
    const path = paths.find((candidate) => candidate.replace(/^.*\//, '').replace(/\.tsx?$/, '') === name);
    if (path) return modules[path];
  }
  return undefined;
}

/**
 * Loads an optional view found by import.meta.glob. A view that is absent or fails
 * to load renders a fallback, so one missing module never takes the app down.
 */
export function guardedView<P extends object>(modules: Record<string, Loader>, names: string[], exportName: string, title: string) {
  const load = pick(modules, names);
  const fallback = () => <Notice title={`${title} unavailable`} />;
  return lazy(async (): Promise<{ default: ComponentType<P> }> => {
    if (!load) return { default: fallback };
    try {
      const mod = (await load()) as Record<string, unknown>;
      const view = (mod.default ?? mod[exportName]) as ComponentType<P> | undefined;
      return { default: view ?? fallback };
    } catch (error) {
      console.error(`Could not load ${title}`, error);
      return { default: fallback };
    }
  });
}

export class ViewBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(error);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <Notice title={`${this.props.title} unavailable`} action={<Button onClick={() => window.location.reload()}>Reload</Button>} />;
  }
}
