import { tmpdir } from "node:os";

import { z } from "zod";

/** Preloaded before every test file: a local stand-in for fsre.edupage.org and a throwaway SQLite file. */
export const edupage: { items: object[] } = { items: [] };

const database = {
  r: {
    tables: [
      { id: "teachers", data_rows: [{ id: "-1", short: "Prof. Ivo Ivić" }] },
      {
        id: "subjects",
        data_rows: [{ id: "-10", name: "Operacijski sustavi", short: "OS" }],
      },
      { id: "classrooms", data_rows: [{ id: "-5", short: "115" }] },
      {
        id: "classes",
        data_rows: [
          {
            id: "-54",
            name: "Preddiplomski studij računarstva- 2.godina",
            short: "R2",
          },
          { id: "-99", name: "Tečaj bez godine", short: "T" },
        ],
      },
      {
        id: "event_types",
        data_rows: [{ id: "ttcancel", name: "Otkazana nastava" }],
      },
    ],
  },
};

const TimetableRequest = z.object({
  __args: z.tuple([
    z.null(),
    z.object({ datefrom: z.iso.date(), dateto: z.iso.date() }),
  ]),
});
const DatedItem = z.looseObject({ date: z.string() });

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname.endsWith("maindbi.js"))
      return Response.json(database);
    const body = TimetableRequest.parse(await request.json());
    const [, { datefrom, dateto }] = body.__args;
    const ttitems = edupage.items.filter((item) => {
      const dated = DatedItem.safeParse(item);
      return (
        !dated.success ||
        (dated.data.date >= datefrom && dated.data.date <= dateto)
      );
    });
    return Response.json({ r: { ttitems } });
  },
});

process.env["EDUPAGE_URL"] = server.url.href;
process.env["DATABASE_URL"] =
  `file:${tmpdir()}/fsre-sync-backend-test-${crypto.randomUUID()}.db`;
process.env["LOG_LEVEL"] = "error";
