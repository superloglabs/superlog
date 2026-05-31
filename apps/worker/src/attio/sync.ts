import {
  type AttioValues,
  type OrgSnapshot,
  type OrgTraceMetrics,
  type UserSnapshot,
  buildAttioSyncPlan,
} from "./domain.js";

export type AttioRecordRef = { recordId: string };

export type AttioClient = {
  listCompanyRecordsBySuperlogOrgId(): Promise<Map<string, string>>;
  createRecord(object: "companies" | "people", values: AttioValues): Promise<AttioRecordRef>;
  updateRecordOverwrite(
    object: "companies" | "people",
    recordId: string,
    values: AttioValues,
  ): Promise<void>;
  upsertRecord(
    object: "companies" | "people",
    matchingAttribute: string,
    values: AttioValues,
  ): Promise<AttioRecordRef>;
};

export type AttioRepository = {
  loadOrgSnapshots(): Promise<OrgSnapshot[]>;
  loadUserSnapshots(): Promise<UserSnapshot[]>;
  loadTraceMetricsByOrgId(orgs: OrgSnapshot[]): Promise<Map<string, OrgTraceMetrics>>;
};

export type SyncAttioResult = {
  startedAt: string;
  finishedAt: string;
  companiesUpdated: number;
  companiesCreated: number;
  peopleUpserted: number;
  companyTeamsUpdated: number;
  personRecordIdsByEmail: Record<string, string>;
  totals: ReturnType<typeof buildAttioSyncPlan>["totals"];
  errors: Array<{ phase: string; key: string; message: string }>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncAttio(input: {
  repository: AttioRepository;
  client: AttioClient;
}): Promise<SyncAttioResult> {
  const startedAt = new Date().toISOString();
  const errors: SyncAttioResult["errors"] = [];
  let companiesUpdated = 0;
  let companiesCreated = 0;
  let peopleUpserted = 0;
  let companyTeamsUpdated = 0;
  const personRecordIdsByEmail: Record<string, string> = {};

  const [orgs, users, companyRecordsByOrgId] = await Promise.all([
    input.repository.loadOrgSnapshots(),
    input.repository.loadUserSnapshots(),
    input.client.listCompanyRecordsBySuperlogOrgId(),
  ]);
  const tracesByOrgId = await input.repository.loadTraceMetricsByOrgId(orgs);
  const plan = buildAttioSyncPlan({ orgs, users, companyRecordsByOrgId, tracesByOrgId });
  const mutableCompanyRecordsByOrgId = new Map(companyRecordsByOrgId);

  for (const payload of plan.companyUpdates) {
    try {
      await input.client.updateRecordOverwrite(payload.object, payload.recordId, payload.values);
      companiesUpdated += 1;
    } catch (error) {
      errors.push({ phase: "company_update", key: payload.orgId, message: message(error) });
    }
  }

  for (const payload of plan.companyCreates) {
    try {
      const created = await input.client.createRecord(payload.object, payload.values);
      mutableCompanyRecordsByOrgId.set(payload.orgId, created.recordId);
      companiesCreated += 1;
    } catch (error) {
      errors.push({ phase: "company_create", key: payload.orgId, message: message(error) });
    }
  }

  for (const payload of plan.peopleUpserts) {
    try {
      const person = await input.client.upsertRecord(
        payload.object,
        payload.matchingAttribute,
        payload.values,
      );
      personRecordIdsByEmail[payload.email] = person.recordId;
      peopleUpserted += 1;
    } catch (error) {
      errors.push({ phase: "person_upsert", key: payload.email, message: message(error) });
    }
  }

  const teamPlan = buildAttioSyncPlan({
    orgs,
    users,
    companyRecordsByOrgId: mutableCompanyRecordsByOrgId,
    tracesByOrgId,
  });

  for (const payload of teamPlan.companyTeamUpdates) {
    const team = [];
    let missingPerson = false;
    for (const email of payload.memberEmails) {
      const recordId = personRecordIdsByEmail[email];
      if (!recordId) {
        missingPerson = true;
        errors.push({
          phase: "company_team_update",
          key: payload.orgId,
          message: `No Attio person record ID for ${email}`,
        });
        break;
      }
      team.push({ target_object: "people", target_record_id: recordId });
    }
    if (missingPerson) continue;

    try {
      await input.client.updateRecordOverwrite(payload.object, payload.recordId, { team });
      companyTeamsUpdated += 1;
    } catch (error) {
      errors.push({ phase: "company_team_update", key: payload.orgId, message: message(error) });
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    companiesUpdated,
    companiesCreated,
    peopleUpserted,
    companyTeamsUpdated,
    personRecordIdsByEmail,
    totals: teamPlan.totals,
    errors,
  };
}
