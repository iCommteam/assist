import type { ReactNode } from "react";

export function AuthPage({
  children,
  description,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm space-y-6">
        <div className="flex flex-col gap-2">
          <h1 className="type-page-title">{title}</h1>
          <p className="type-supporting-body text-muted-foreground">
            {description}
          </p>
        </div>
        {children}
      </section>
    </main>
  );
}
