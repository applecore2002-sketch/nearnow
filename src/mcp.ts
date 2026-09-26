import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPlaceDetails, listCategories, searchPlaces } from './search.js';

const SEARCH_DESCRIPTION =
  'Find nearby public places from OpenStreetMap: pharmacies, supermarkets, gas stations, ' +
  'EV chargers, libraries, post offices (US coverage first). Pass either a location {lat,lng} ' +
  'or an area name like "Pasadena, CA". Each result includes distance, address, opening hours ' +
  'with hours_confidence (confirmed = from OSM data, estimated = chain/category default, ' +
  'unknown), and open_now where determinable. Set open_now=true to keep only places likely ' +
  'open right now (unknown hours are excluded, never guessed).';

// The SDK expects structuredContent values to carry a string index signature.
function structured(obj: unknown): Record<string, unknown> {
  return obj as Record<string, unknown>;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'nearnow', version: '0.1.0' });

  server.registerTool(
    'search_places',
    {
      title: 'Search public places',
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        location: z
          .object({
            lat: z.number().min(-90).max(90),
            lng: z.number().min(-180).max(180),
          })
          .optional(),
        area: z.string().min(2).max(80).optional(),
        category: z.string().min(2).max(40),
        radius_m: z.number().int().min(100).max(20000).optional(),
        open_now: z.boolean().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      },
    },
    async (args) => {
      const res = await searchPlaces(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(res) }],
        structuredContent: structured(res),
        isError: res.status === 'INVALID_INPUT',
      };
    }
  );

  server.registerTool(
    'get_place_details',
    {
      title: 'Get place details',
      description:
        'Get full details for one place by its place_id (e.g. "osm:node/123") returned by ' +
        'search_places: exact coordinates, address, opening hours with confidence, contact info ' +
        'and the OpenStreetMap URL.',
      inputSchema: {
        place_id: z.string().min(6).max(60),
      },
    },
    async ({ place_id }) => {
      const res = await getPlaceDetails(place_id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(res) }],
        structuredContent: structured(res),
        isError: res.status !== 'OK',
      };
    }
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List supported place categories',
      description:
        'List the place categories NearNow can search (pharmacy, supermarket, fuel, ev_charging, ' +
        'library, post_office) with an example query for each. Call this if unsure which category ' +
        'value to pass to search_places.',
      inputSchema: {},
    },
    async () => {
      const res = listCategories();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(res) }],
        structuredContent: structured(res),
      };
    }
  );

  return server;
}
