// Reemplazo de "@hatch/space-sdk/client" para la versión independiente
// (Render). Implementa el mismo protocolo que el SDK: POST ./actions con
// { action, args } y respuesta { data } | { error }.

import { QueryClient } from "@tanstack/react-query";

export const spaceQueryClient = new QueryClient();

export function SafeAreaTopScrim({
  backgroundColor,
}: {
  backgroundColor?: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        backgroundColor,
        height: "env(safe-area-inset-top, 0px)",
      }}
    />
  );
}

export function createActionClient(options?: { endpoint?: string }) {
  const endpoint = options?.endpoint ?? "./actions";
  return new Proxy(
    {},
    {
      get(_target, name) {
        if (
          typeof name !== "string" ||
          name === "then" ||
          name === "catch" ||
          name === "finally"
        ) {
          return undefined;
        }
        return async (args?: unknown) => {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: name, args: args ?? {} }),
          });
          const body = (await response.json().catch(() => null)) as {
            data?: unknown;
            error?: unknown;
          } | null;
          if (body && typeof body === "object" && body.error) {
            throw new Error(String(body.error));
          }
          if (!response.ok) {
            throw new Error(
              `La acción ${name} falló (${response.status})`,
            );
          }
          return body?.data;
        };
      },
    },
  );
}

// Tipos de conveniencia (solo para TypeScript; no se usan en tiempo de
// ejecución en esta versión).
export type ApiRequest = Record<string, unknown>;
export type ApiResponse = Record<string, unknown>;
