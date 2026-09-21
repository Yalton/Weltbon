import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface AssetSummary {
  id: string;
  universeId: string;
  filename: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  thumbSizeBytes: number;
  altText: string | null;
  // so <img src> can load without Authorization: Bearer header).
  rawUrl: string;
  thumbUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetUsage {
  count: number;
  references: Array<{ entryId: string; title: string; kind: 'cover' | 'inline' }>;
}


export function useAssets(universeId: string) {
  return useQuery({
    queryKey: ['assets', universeId],
    queryFn: () => api<AssetSummary[]>(`/universes/${universeId}/assets`),
    enabled: !!universeId,
  });
}

export function useUploadAsset(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      // api() client skips Content-Type:application/json when body instanceof FormData
      // (confirmed in web/src/api/client.ts lines 68-71) — browser sets multipart boundary.
      return api<AssetSummary>(`/universes/${universeId}/assets`, {
        method: 'POST',
        body: fd,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets', universeId] });
    },
  });
}

export function useDeleteAsset(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) =>
      api<void>(`/universes/${universeId}/assets/${assetId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets', universeId] });
    },
  });
}

export function useRenameAsset(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, filename }: { assetId: string; filename: string }) =>
      api<{ filename: string }>(`/universes/${universeId}/assets/${assetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ filename }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets', universeId] });
    },
  });
}

export function useAssetUsage(universeId: string, assetId: string | null) {
  return useQuery({
    queryKey: ['asset-usage', universeId, assetId],
    queryFn: () =>
      api<AssetUsage>(`/universes/${universeId}/assets/${assetId!}/usage`),
    enabled: !!universeId && !!assetId,
  });
}
