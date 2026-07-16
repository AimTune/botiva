// Example MCP server — a small web-shop backed by a REAL in-memory SQL
// database (node:sqlite), exposed over MCP (Streamable HTTP, stateless, no
// auth). It exists so mcp-demo-server.ts has a genuine MCP endpoint with a
// mix of harmless and SENSITIVE tools:
//
//   list_products   — public catalog                        (harmless)
//   create_order    — writes an order, checks stock         (params contain customer ids)
//   run_sql         — read-only SQL over the whole DB,      (SENSITIVE: returns
//                     including customer PII                  emails/phones — the demo
//                                                             server hides it from clients)
//
//   pnpm exec tsx examples/mcp-server.ts    # standalone → http://localhost:8794/mcp
//
// or import { startMcpExampleServer } and boot it in-process (what
// mcp-demo-server.ts does). No credentials required. Needs Node ≥ 22.5
// (node:sqlite).

import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ── the database (module-level: every request sees the same data) ───────────

const db = new DatabaseSync(":memory:");
db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT);
    CREATE TABLE products  (id INTEGER PRIMARY KEY, name TEXT, price REAL, stock INTEGER);
    CREATE TABLE orders    (id INTEGER PRIMARY KEY AUTOINCREMENT,
                            customer_id INTEGER, product_id INTEGER,
                            qty INTEGER, total REAL, status TEXT);

    INSERT INTO customers VALUES
        (1, 'Ada Wong',      'ada@example.com',   '+90-555-0101'),
        (2, 'Grace Hopper',  'grace@example.com', '+90-555-0102'),
        (3, 'Alan Kay',      'alan@example.com',  '+90-555-0103');

    INSERT INTO products VALUES
        (1, 'Mechanical Keyboard', 89.90, 12),
        (2, 'USB-C Hub',           34.50, 40),
        (3, '4K Monitor',         329.00,  5),
        (4, 'Noise-cancelling Headphones', 199.00, 8);

    INSERT INTO orders (customer_id, product_id, qty, total, status) VALUES
        (1, 3, 1, 329.00, 'shipped'),
        (2, 1, 2, 179.80, 'pending'),
        (3, 4, 1, 199.00, 'delivered');
`);

// ── tools ────────────────────────────────────────────────────────────────────

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

function buildMcpServer(): McpServer {
    const server = new McpServer({ name: "botiva-example-shop", version: "1.0.0" });

    server.registerTool(
        "list_products",
        { description: "Lists the product catalog (id, name, price, stock)." },
        async () => json(db.prepare("SELECT * FROM products").all()),
    );

    server.registerTool(
        "create_order",
        {
            description:
                "Creates an order for a customer (checks stock, computes the total, decrements stock).",
            inputSchema: {
                customerId: z.number().describe("customer id"),
                productId: z.number().describe("product id from list_products"),
                qty: z.number().int().positive().describe("quantity"),
            },
        },
        async ({ customerId, productId, qty }) => {
            const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);
            const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as
                | { id: number; name: string; price: number; stock: number }
                | undefined;
            if (!customer) return json({ error: `No customer with id ${customerId}.` });
            if (!product) return json({ error: `No product with id ${productId}.` });
            if (product.stock < qty) {
                return json({ error: `Only ${product.stock} × "${product.name}" in stock.` });
            }
            const total = Math.round(product.price * qty * 100) / 100;
            db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").run(qty, productId);
            const info = db
                .prepare(
                    "INSERT INTO orders (customer_id, product_id, qty, total, status) VALUES (?, ?, ?, ?, 'pending')",
                )
                .run(customerId, productId, qty, total);
            return json({ orderId: Number(info.lastInsertRowid), product: product.name, qty, total, status: "pending" });
        },
    );

    server.registerTool(
        "run_sql",
        {
            description:
                "Runs a read-only SQL SELECT against the shop database " +
                "(tables: customers(id,name,email,phone), products(id,name,price,stock), " +
                "orders(id,customer_id,product_id,qty,total,status)). " +
                "Returns raw rows — may contain customer PII.",
            inputSchema: { sql: z.string().describe("a single SELECT statement") },
        },
        async ({ sql }) => {
            if (!/^\s*select\b/i.test(sql) || sql.replace(/;\s*$/, "").includes(";")) {
                return json({ error: "Only a single SELECT statement is allowed." });
            }
            try {
                const rows = db.prepare(sql).all();
                return json(rows.slice(0, 50));
            } catch (err) {
                return json({ error: `SQL error: ${(err as Error).message}` });
            }
        },
    );

    return server;
}

/** Start the example MCP server; resolves once it is listening on `port`. */
export async function startMcpExampleServer(port: number): Promise<Server> {
    const app = express();
    app.use(express.json());

    // Stateless Streamable HTTP: fresh McpServer + transport per POST, torn
    // down when the response closes. No sessions, no auth — example-grade.
    app.post("/mcp", async (req, res) => {
        const mcp = buildMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
            void transport.close();
            void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });

    // No sessions ⇒ nothing to GET (notification stream) or DELETE.
    const methodNotAllowed = (_req: unknown, res: express.Response) => {
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
        });
    };
    app.get("/mcp", methodNotAllowed);
    app.delete("/mcp", methodNotAllowed);

    app.get("/healthz", (_req, res) => {
        const orders = db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number };
        res.json({ ok: true, server: "botiva-example-shop-mcp", orders: orders.n });
    });

    const server = createServer(app);
    await new Promise<void>((r) => server.listen(port, r));
    return server;
}

// Standalone mode: `pnpm exec tsx examples/mcp-server.ts`
const runDirectly =
    process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (runDirectly) {
    const port = Number(process.env.MCP_PORT ?? 8794);
    await startMcpExampleServer(port);
    console.log(`\n✓ example MCP server (shop + SQL) ready → http://localhost:${port}/mcp\n`);
}
