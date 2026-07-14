export type IntegrationCatalogItem = {
  id: string;
  name: string;
  description: string;
  category: string;
  keywords: string[];
  installed: boolean;
};

export function partitionIntegrations<T extends IntegrationCatalogItem>(
  items: T[],
): {
  configured: T[];
  available: T[];
} {
  return {
    configured: items.filter((item) => item.installed),
    available: items.filter((item) => !item.installed),
  };
}

export function filterAvailableIntegrations<T extends IntegrationCatalogItem>(
  items: T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const { available } = partitionIntegrations(items);
  if (!normalizedQuery) return available;

  return available.filter((item) =>
    [item.name, item.description, item.category, ...item.keywords]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}
