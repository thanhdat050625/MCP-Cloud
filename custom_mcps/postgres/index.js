#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
const { Pool } = pg;

const databaseUrl = process.argv[2];
if (!databaseUrl) {
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', () => {
  // Ignore idle client errors
});

const server = new Server(
  {
    name: 'postgres-gateway-tool',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'query',
        description: 'Execute any SQL query (SELECT, INSERT, UPDATE, DELETE, etc.) on PostgreSQL database with full read-write permissions.',
        inputSchema: {
          type: 'object',
          properties: {
            sql: {
              type: 'string',
              description: 'The SQL query to execute',
            },
          },
          required: ['sql'],
        },
      },
      {
        name: 'list_tables',
        description: 'List all tables and columns in the public schema.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'query') {
    const sql = args?.sql;
    if (!sql || typeof sql !== 'string') {
      throw new Error('Missing or invalid "sql" parameter');
    }

    try {
      const res = await pool.query(sql);
      let resultText;
      if (res.rows && res.rows.length > 0) {
        resultText = JSON.stringify(res.rows, null, 2);
      } else {
        resultText = JSON.stringify({
          command: res.command,
          rowCount: res.rowCount,
          message: 'Query executed successfully with 0 rows returned.',
        }, null, 2);
      }

      return {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `SQL Error: ${error.message}`,
          },
        ],
      };
    }
  }

  if (name === 'list_tables') {
    try {
      const res = await pool.query(`
        SELECT 
          table_name,
          column_name,
          data_type,
          is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position;
      `);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error listing tables: ${error.message}`,
          },
        ],
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch(() => {
  process.exit(1);
});
