import { queryOptions } from "@tanstack/react-query";
import { getApp, getApps, getSession } from "./api";

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: () => getSession(),
  staleTime: 60_000,
});

export const appsQuery = queryOptions({
  queryKey: ["apps"],
  queryFn: () => getApps(),
});

export const appQuery = (appKey: string) =>
  queryOptions({
    queryKey: ["apps", appKey],
    queryFn: () => getApp({ data: appKey }),
    // Install links carry an expiring token; refresh them regularly.
    refetchInterval: 15 * 60_000,
  });
