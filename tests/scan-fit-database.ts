import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  orderDatabase,
  adminId,
  salesId,
  financeId,
  opsId,
} from "./order-backend.mjs";
import { DEFAULT_CONFIG } from "../src/lib/scan-fit/model";
import { aggregate, analyse } from "../src/lib/scan-fit/geometry";
import { syntheticObservation, syntheticProfile } from "./scan-fit-fixtures";
import { emptyDraft } from "../src/lib/orders/model";

const { db, request } = await orderDatabase({ scanFit: true }),
  customer = randomUUID(),
  other = randomUUID(),
  order = randomUUID();
await db.query(
  "insert into public.customers(id,first_name,last_name,assigned_to) values($1,'Synthetic','Scan',$2),($3,'Other','Scan',$4)",
  [customer, salesId, other, adminId],
);
await db.query(
  "insert into public.orders(id,customer_id,created_by) values($1,$2,$3)",
  [order, customer, salesId],
);
const call = async (operation: string, payload: unknown, actor = adminId) =>
  db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (
      await tx.query<{ value: { id: string } }>(
        "select public.scan_fit_operate($1,$2,$3::jsonb) value",
        [actor, operation, JSON.stringify(payload)],
      )
    ).rows[0].value;
  });
let profileId = "",
  sessionId = "";
const start = async (validation_mode = true, order_id = order) =>
  call("start", {
    customer_id: customer,
    order_id,
    profile_id: profileId,
    validation_mode,
    device_info: { fixture: true },
  });
async function review(id: string, resultMode = "valid") {
  const frames = [];
  for (let i = 0; i < 5; i++) {
    const observation = syntheticObservation(i),
      analysis = analyse(observation, syntheticProfile, DEFAULT_CONFIG),
      prefix = customer + "/" + id + "/" + randomUUID();
    const paths = {
      original_path: prefix + "-original.jpg",
      annotated_path: prefix + "-annotated.jpg",
      rectified_path: prefix + "-rectified.jpg",
    };
    for (const path of Object.values(paths))
      await db.query(
        "insert into storage.objects(bucket_id,name) values('scan-fit',$1)",
        [path],
      );
    frames.push({
      frame_index: i,
      observation,
      analysis,
      ...paths,
      image_sha256: createHash("sha256")
        .update(id + String(i))
        .digest("hex"),
    });
  }
  const result =
    resultMode !== "invalid"
      ? aggregate(
          frames.map((f) => f.analysis),
          DEFAULT_CONFIG,
        )
      : null;
  if (result && resultMode === "low") result.qualityScore = 0.6;
  await call("review", { session_id: id, frames, result });
  return { frames, result };
}
try {
  await test("Scan Fit tables have RLS and its image bucket is private", async () => {
    assert.equal(
      (
        await db.query(
          "select tablename from pg_tables where tablename like 'scan_fit_%' and not rowsecurity",
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query<{ public: boolean }>(
          "select public from storage.buckets where id='scan-fit'",
        )
      ).rows[0].public,
      false,
    );
  });
  await test("browser JWTs and anonymous users cannot invoke server persistence", async () => {
    for (const actor of [salesId, adminId, null])
      await assert.rejects(
        () =>
          request(
            "select public.scan_fit_operate($1,'profile',$2::jsonb)",
            [adminId, JSON.stringify(syntheticProfile)],
            actor,
          ),
        /permission denied/,
      );
  });
  await test("profile publishing is administrator only and versions are immutable", async () => {
    await assert.rejects(
      () => call("profile", syntheticProfile, salesId),
      /Administrator/,
    );
    profileId = (await call("profile", syntheticProfile)).id;
    await assert.rejects(
      () => call("profile", syntheticProfile),
      /duplicate key/,
    );
    assert.equal(
      (
        await request(
          "select * from public.scan_fit_frame_profiles",
          [],
          salesId,
        )
      ).length,
      1,
    );
    await assert.rejects(
      () =>
        request(
          "update public.scan_fit_frame_profiles set name='changed' where id=$1",
          [profileId],
          adminId,
        ),
      /permission denied/,
    );
  });
  await test("session context is scoped to clinical staff and the linked customer", async () => {
    for (const actor of [financeId, opsId])
      await assert.rejects(
        () =>
          call(
            "start",
            { customer_id: customer, order_id: order, profile_id: profileId },
            actor,
          ),
        /Access denied/,
      );
    await assert.rejects(
      () =>
        call(
          "start",
          { customer_id: other, order_id: order, profile_id: profileId },
          adminId,
        ),
      /Access denied/,
    );
    await assert.rejects(
      () =>
        call("start", { customer_id: other, profile_id: profileId }, salesId),
      /Access denied/,
    );
    sessionId = (await start()).id;
  });
  await test("session profile and threshold snapshots survive later configuration versions", async () => {
    await call("config", { ...DEFAULT_CONFIG, maxYaw: 2 });
    const rows = await db.query<{
      config_snapshot: { version: number; maxYaw: number };
    }>("select config_snapshot from public.scan_fit_sessions where id=$1", [
      sessionId,
    ]);
    assert.equal(rows.rows[0].config_snapshot.version, 1);
    assert.equal(rows.rows[0].config_snapshot.maxYaw, 3);
    await assert.rejects(
      () => call("config", DEFAULT_CONFIG),
      /Configuration changed/,
    );
  });
  await test("five-frame review persists a result without accepting or applying it", async () => {
    await review(sessionId);
    assert.equal(
      (
        await request(
          "select * from public.scan_fit_frames where session_id=$1",
          [sessionId],
          salesId,
        )
      ).length,
      5,
    );
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from public.scan_fit_sessions where id=$1",
          [sessionId],
        )
      ).rows[0].status,
      "Review",
    );
    assert.equal(
      (
        await db.query("select * from public.measurements where order_id=$1", [
          order,
        ])
      ).rows.length,
      0,
    );
  });
  await test("anonymous and unrelated roles cannot read scan records or images", async () => {
    const path = (
      await db.query<{ original_path: string }>(
        "select original_path from public.scan_fit_frames where session_id=$1 limit 1",
        [sessionId],
      )
    ).rows[0].original_path;
    for (const actor of [financeId, opsId]) {
      assert.equal(
        (await request("select * from public.scan_fit_frames", [], actor))
          .length,
        0,
      );
      assert.equal(
        (
          await request(
            "select * from storage.objects where bucket_id='scan-fit' and name=$1",
            [path],
            actor,
          )
        ).length,
        0,
      );
    }
    await assert.rejects(
      () => request("select * from public.scan_fit_frames", [], null),
      /permission denied/,
    );
    assert.equal(
      (
        await request(
          "select * from storage.objects where bucket_id='scan-fit' and name=$1",
          [path],
          salesId,
        )
      ).length,
      1,
    );
  });
  await test("manual correction preserves algorithm pixels, actor, reason and audit history", async () => {
    const frame = (
      await db.query<{
        id: string;
        observation: ReturnType<typeof syntheticObservation>;
      }>(
        "select id,observation from public.scan_fit_frames where session_id=$1 order by frame_index limit 1",
        [sessionId],
      )
    ).rows[0];
    const original = structuredClone(frame.observation.pupils),
      corrected = {
        right: { ...original!.right, x: original!.right.x + 0.1 },
        left: original!.left,
      };
    const adjusted = analyse(
      { ...frame.observation, pupils: corrected },
      syntheticProfile,
      DEFAULT_CONFIG,
    );
    const analyses = Array.from({ length: 5 }, (_, i) =>
      i === 0
        ? adjusted
        : analyse(syntheticObservation(i), syntheticProfile, DEFAULT_CONFIG),
    );
    await call("manual", {
      session_id: sessionId,
      frame_id: frame.id,
      pupils: corrected,
      reason: "Synthetic correction test",
      analysis: adjusted,
      result: aggregate(analyses, DEFAULT_CONFIG),
    });
    const unchanged = (
      await db.query<{ observation: ReturnType<typeof syntheticObservation> }>(
        "select observation from public.scan_fit_frames where id=$1",
        [frame.id],
      )
    ).rows[0];
    assert.deepEqual(unchanged.observation.pupils, original);
    assert.equal(
      (
        await db.query(
          "select * from public.scan_fit_adjustments where frame_id=$1 and operator_id=$2",
          [frame.id, adminId],
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await db.query(
          "select * from public.audit_logs where entity_type='scan_fit' and action='MANUAL' and user_id=$1",
          [adminId],
        )
      ).rows.length,
      1,
    );
  });
  await test("explicit acceptance locks the session and retains its result across reads", async () => {
    await call("accept", { session_id: sessionId });
    await assert.rejects(
      () => call("manual", { session_id: sessionId }),
      /unaccepted/,
    );
    await assert.rejects(
      () => call("repeat", { session_id: sessionId }),
      /accepted history/,
    );
    const accepted = await request(
      "select * from public.scan_fit_results where session_id=$1",
      [sessionId],
      salesId,
    );
    assert.equal(accepted.length, 1);
    assert.ok(accepted[0].accepted_at);
  });
  await test("applying a TEST order requires explicit confirmation and rejects stale comparisons", async () => {
    await assert.rejects(
      () => call("apply", { session_id: sessionId }),
      /Production ordering disabled/,
    );
    await assert.rejects(
      () =>
        call("apply", {
          session_id: sessionId,
          test_order_confirmed: true,
          expected_measurements: { right_bd: 1 },
          expected_version: 1,
        }),
      /changed/,
    );
    await call("apply", {
      session_id: sessionId,
      test_order_confirmed: true,
      expected_measurements: null,
      expected_version: 1,
    });
    const measurement = (
      await db.query<{
        right_bd: string;
        left_bd: string;
        scan_fit_session_id: string;
      }>("select * from public.measurements where order_id=$1", [order])
    ).rows[0];
    assert.ok(Math.abs(Number(measurement.right_bd) - 31.97) < 0.03);
    assert.equal(measurement.scan_fit_session_id, sessionId);
    await assert.rejects(
      () =>
        call("apply", {
          session_id: sessionId,
          test_order_confirmed: true,
          expected_measurements: null,
          expected_version: 1,
        }),
      /changed/,
    );
    assert.equal(
      (
        await db.query(
          "select * from public.audit_logs where entity_type='scan_fit' and action='APPLY' and previous_value is null and new_value->>'scan_fit_session_id'=$1",
          [sessionId],
        )
      ).rows.length,
      1,
    );
  });
  await test("existing order edits clear stale Scan Fit provenance without deleting accepted history", async () => {
    const draft = emptyDraft(customer);
    draft.measurements = {
      right_bd: 34,
      left_bd: 31,
      working_distance: 400,
      notes: "Manual CRM edit after synthetic scan",
    };
    const version = (
      await db.query<{ version: number }>(
        "select version from public.orders where id=$1",
        [order],
      )
    ).rows[0].version;
    await request(
      "select public.save_order($1,$2::jsonb,$3)",
      [order, JSON.stringify(draft), version],
      adminId,
    );
    const m = (
      await db.query<{
        scan_fit_session_id: string | null;
        right_pupil_height: number | null;
      }>("select * from public.measurements where order_id=$1", [order])
    ).rows[0];
    assert.equal(m.scan_fit_session_id, null);
    assert.equal(Number(m.right_pupil_height), 20);
    assert.equal(
      (
        await request(
          "select * from public.scan_fit_results where session_id=$1",
          [sessionId],
          adminId,
        )
      ).length,
      1,
    );
  });
  await test("normal sessions remain blocked from production ordering", async () => {
    const normal = (await start(false)).id;
    await review(normal);
    await call("accept", { session_id: normal });
    await assert.rejects(
      () => call("apply", { session_id: normal, test_order_confirmed: true }),
      /Production ordering disabled/,
    );
  });
  await test("inconsistent review cannot be accepted, and repeat creates a new traceable session", async () => {
    const lowQuality = (await start()).id;
    await review(lowQuality, "low");
    await assert.rejects(
      () => call("accept", { session_id: lowQuality }),
      /Overall measurement quality is insufficient/,
    );
    const invalid = (await start()).id;
    await review(invalid, "invalid");
    await assert.rejects(
      () => call("accept", { session_id: invalid }),
      /consistency insufficient/,
    );
    const repeated = await call("repeat", { session_id: invalid });
    assert.notEqual(repeated.id, invalid);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from public.scan_fit_sessions where id=$1",
          [invalid],
        )
      ).rows[0].status,
      "Repeated",
    );
  });
  await test("validation references are administrator-only and never broadly visible", async () => {
    await call("reference", {
      session_id: sessionId,
      reference: {
        method: "Synthetic reference",
        rightPd: 32,
        leftPd: 31,
        rightHeight: 20,
        leftHeight: 21,
      },
      errors: {
        meanAbsoluteError: 0,
        bias: 0,
        signed: {
          rightPd: 0,
          leftPd: 0,
          totalPd: 0,
          rightHeight: 0,
          leftHeight: 0,
        },
      },
    });
    assert.equal(
      (await request("select * from public.scan_fit_validation", [], salesId))
        .length,
      0,
    );
    assert.equal(
      (await request("select * from public.scan_fit_validation", [], adminId))
        .length,
      1,
    );
  });
  await test("archive restricts image access without deleting accepted scan history", async () => {
    await call("archive", { session_id: sessionId });
    assert.equal(
      (
        await request(
          "select * from storage.objects where bucket_id='scan-fit' and name in(select original_path from public.scan_fit_frames where session_id=$1)",
          [sessionId],
          salesId,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await request(
          "select * from public.scan_fit_results where session_id=$1",
          [sessionId],
          salesId,
        )
      ).length,
      1,
    );
  });
  await test("deactivation blocks previously authorized access and writes", async () => {
    await db.query("update public.users set active=false where id=$1", [
      salesId,
    ]);
    assert.equal(
      (await request("select * from public.scan_fit_sessions", [], salesId))
        .length,
      0,
    );
    await assert.rejects(
      () =>
        call(
          "start",
          { customer_id: customer, profile_id: profileId },
          salesId,
        ),
      /Access denied/,
    );
  });
} finally {
  await db.close();
}
