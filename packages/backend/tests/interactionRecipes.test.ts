/**
 * Journeys traced from the source, in the shape of PR #2577's Education
 * Management page:
 *
 *   - "Reset Education" opens a dialog; the dialog needs a date and is
 *     submitted; a confirmation follows; then GET reset_education_manual.
 *   - The PR's change: handleOnSaveSuperSave refreshes the history dialog only
 *     when the selected user has user_email and user_id, and refresh() asks for
 *     user details only when user_email is set. Super Save is toggled from a
 *     data-grid row, or inside the history dialog that "View History" opens.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, after } from 'node:test';

process.env.DATABASE_URL = 'sqlite::memory:';

const { discoverApiEvidence } = await import('../src/analysis/behaviorEvidence.js');
const { buildRecipes, renderRecipes, recipeTriggers } = await import('../src/analysis/interactionRecipes.js');
const { renderFlowsModule, renderProofSpec } = await import('../src/playwright/flows.js');
const { synthesizeConditionTest } = await import('../src/pipeline/conditionTests.js');
const { preflightSpec, readPageObjects } = await import('../src/playwright/preflight.js');
const { QA_HELPERS } = await import('../src/playwright/scaffold.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-journeys-'));
after(() => fs.rmSync(repo, { recursive: true, force: true }));
const put = (rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content); };

put('src/locale/en.json', JSON.stringify({
  education_management_action_reset_button: 'Reset Education',
  education_management_action_approve_button: 'Approve All',
  education_management_reset_confirm_title: 'Reset Education?',
  education_management_education_reset_dialog_date_label: 'Education Date',
  education_management_actions_view_history_text: 'View History',
  users_column_header_user_super_save: 'Super Save',
  basic_information_check_education_history: 'Check Education History',
  date_modal_ok_text: 'Ok',
  common_yes_button: 'Yes',
}));
put('src/common/utils/ids.ts', `export const htmlIds = toIds(["btn_bug_report_save_request", "super_save_education_reset_date", "btn_super_save_education_reset", "btn_confirmation_dialog_yes"]);\n`);
put('src/api/url.ts', `export const API_URL = {
  resetUserEducationManual: "/super-save/reset_education_manual",
  approveUserEducationAll: "/super-save/approve_all_education",
  updateUserSuperSaveStatus: "/super-save/change_super_save_status",
  getSuperSaveUserDetails: "/super-save/get_user_details",
};\n`);
put('src/api/hooks/education.ts', `
export const useResetEducationManual = () => useMutation({ mutationFn: async ({ date }) => (await api.get(API_URL.resetUserEducationManual, { params: { date } })).data });
export const useApproveEducationAll = () => useMutation({ mutationFn: async () => (await api.get(API_URL.approveUserEducationAll)).data });
export const usePostUpdateUserSuperSaveStatus = () => useMutation({ mutationFn: async (data) => (await api.post(API_URL.updateUserSuperSaveStatus, data)).data });
export const useGetSuperUserDetail = (params, options) => useQuery(["details", params], async () => (await api.get(API_URL.getSuperSaveUserDetails, { params })).data, options);
`);
put('src/common/context/DialogContext.tsx', `
export const DialogProvider = ({ children }) => {
  const confirmDialog = (props) => setConfirmProps(props);
  return (
    <DialogContext.Provider value={{ confirmDialog }}>
      <FormFooter submitText={confirmProps?.okButtonText || text("common_yes_button")} submitBtnId={htmlIds.btn_confirmation_dialog_yes} />
    </DialogContext.Provider>
  );
};`);
put('src/education/EducationResetDialog.tsx', `
function EducationResetDialog(props, ref) {
  const { onOk } = props;
  useImperativeHandle(ref, () => ({ open: () => { setOpen(true); } }), []);
  const validationSchema = () => Yup.object({
    [htmlIds.super_save_education_reset_date]: Yup.date().required(text("education_management_education_reset_date_required")),
  });
  return (
    <CustomDialog open={open}>
      <Formik onSubmit={async (values) => { await onOk({ date: values.date }); }}>
        <Form>
          <DatesField label={text("education_management_education_reset_dialog_date_label")} {...dateFieldProps(htmlIds.super_save_education_reset_date)} />
          <FormFooter submitText={text("date_modal_ok_text")} submitBtnId={htmlIds.btn_super_save_education_reset} />
        </Form>
      </Formik>
    </CustomDialog>
  );
}
export default forwardRef(EducationResetDialog);`);
const DIALOG = 'src/education/EducationHistoryDialog.tsx';
put(DIALOG, `
function EducationHistoryDialog(props, ref) {
  const { user, onHandleRestriction } = props;
  const { data: user_details, refetch: refetchUserDetails } = useGetSuperUserDetail({ email: user?.user_email }, { enabled: !!user?.user_email });

  useImperativeHandle(ref, () => ({
    open: () => {
      setOpen(true);
    },
    refresh: async () => {
      await Promise.all([
        user?.user_email && refetchUserDetails(),
      ]);
    },
  }), [refetchUserDetails, user?.user_email]);

  const handleSuperSaveToggle = async (data) => {
    if (onHandleRestriction) {
      onHandleRestriction(data);
    }
  };

  return (
    <CustomDialog open={open}>
      <span>{text("users_column_header_user_super_save")}</span>
      <Switch onClick={() => { handleSuperSaveToggle({ user_id: user_details?.id, status: false }); }} checked={false} />
    </CustomDialog>
  );
}
export default forwardRef(EducationHistoryDialog);`);
const PAGE = 'src/education/EducationManagementPage.tsx';
put(PAGE, `
function EducationManagementPage() {
  const { confirmDialog } = useDialog();
  const educationResetDialogRef = useRef(null);
  const educationHistoryDialogRef = useRef(null);
  const [selectedUserForHistory, setSelectedUserForHistory] = useState();
  const { mutateAsync: resetEducationManualApi } = useResetEducationManual();
  const { mutateAsync: approveEducationAllApi } = useApproveEducationAll();
  const { mutateAsync: updateUserSuperSaveStatus } = usePostUpdateUserSuperSaveStatus();

  const handleViewHistory = useCallback((user_id, user_email) => {
    educationHistoryDialogRef.current?.open();
    setSelectedUserForHistory({ user_id, user_email });
  }, []);

  const handleOnSaveSuperSave = useCallback(() => {
    if (selectedUserForHistory?.user_email && selectedUserForHistory?.user_id) {
      educationHistoryDialogRef.current?.refresh();
    }
  }, [selectedUserForHistory]);

  const onUpdateSuperSaveStatus = useCallback(async (props) => {
    await updateUserSuperSaveStatus({ user_id: props.user_id });
    handleOnSaveSuperSave();
  }, [updateUserSuperSaveStatus, handleOnSaveSuperSave]);

  const onHandleRestriction = useCallback(async (props) => {
    confirmDialog({
      title: "Super Save",
      onOk: async () => onUpdateSuperSaveStatus(props),
    });
  }, [confirmDialog, onUpdateSuperSaveStatus]);

  const handleReset = () => {
    educationResetDialogRef.current?.open();
  };

  const handleOnResetEducation = async (submitData) => {
    confirmDialog({
      title: text("education_management_reset_confirm_title"),
      onOk: async () => { await resetEducationManualApi({ date: submitData.date }); },
    });
  };

  const handleApprove = async () => {
    await approveEducationAllApi(null);
  };

  const columns = [
    {
      field: "super_save_restriction",
      headerName: text("users_column_header_user_super_save"),
      renderCell: ({ row }) => {
        return (
          <Switch onClick={() => onHandleRestriction({ user_id: row?.id, status: false })} checked={false} />
        );
      },
    },
    {
      field: "email",
      renderCell: ({ row }) => {
        return <a href={\`/users/user-details?email=\${encodeURIComponent(row.email)}&tabIndex=0\`}>{row.email}</a>;
      },
    },
    {
      field: "action_history",
      renderCell: ({ row }) => {
        return (
          <Button onClick={() => handleViewHistory(row?.id, row?.email)}>
            {text("education_management_actions_view_history_text")}
          </Button>
        );
      },
    },
  ];

  return (
    <div>
      <button id={htmlIds.btn_bug_report_save_request} onClick={handleApprove}>
        <span>{text("education_management_action_approve_button")}</span>
      </button>
      <button id={htmlIds.btn_bug_report_save_request} onClick={handleReset}>
        <span>{text("education_management_action_reset_button")}</span>
      </button>
      <DataGrid columns={columns} />
      <EducationResetDialog ref={educationResetDialogRef} onOk={handleOnResetEducation} />
      <EducationHistoryDialog user={selectedUserForHistory} ref={educationHistoryDialogRef} onHandleRestriction={onHandleRestriction} />
    </div>
  );
}
export default EducationManagementPage;`);

put('src/pages/education-management.ts', `import { EducationManagementPage } from "@sections/education";\nexport default EducationManagementPage;\n`);
put('src/education/index.ts', `export { default as EducationManagementPage } from "./EducationManagementPage";\n`);
put('src/pages/users/user-details/index.ts', `import { SuperUserDetailScreen } from "@sections/user-details";\nexport default SuperUserDetailScreen;\n`);
put('src/user-details/SuperUserDetailScreen.tsx', `
import { BasicInformationTab } from "./components/BasicInformationTab";
export function SuperUserDetailScreen() {
  const { email } = router.query;
  return <BasicInformationTab email={email} />;
}`);
const TAB = 'src/user-details/components/BasicInformationTab/BasicInformationTab.tsx';
put(TAB, `
import { EducationHistoryDialog } from "@education/EducationHistoryDialog";
function BasicInformationTab() {
  const educationHistoryDialogRef = useRef(null);
  return (
    <div>
      <button onClick={() => educationHistoryDialogRef.current?.open()}>
        {text("basic_information_check_education_history")}
      </button>
      <EducationHistoryDialog ref={educationHistoryDialogRef} user={{ user_email: userDetail.email, user_id: userDetail.id }} onHandleRestriction={onHandleRestriction} />
    </div>
  );
}
export default BasicInformationTab;`);
const FILES = [PAGE, DIALOG];
const journeys = () => buildRecipes(repo, FILES, discoverApiEvidence(repo, FILES), '/education-management');
const byName = (name: string) => journeys().find((j) => j.name === name);

describe('journeys', () => {
  test('reset: the button, the dialog with its date, the confirmation - and its request is answered by the flow', () => {
    const reset = journeys().find((j) => j.leadsTo.some((t) => t.path === '/super-save/reset_education_manual'))!;
    assert.deepEqual(reset.steps.map((s) => s.action), ['click', 'submit', 'confirm']);
    const [open, submit, confirm] = reset.steps;
    assert.ok(open!.candidates.some((c) => c.code === "page.getByRole('button', { name: 'Reset Education', exact: true })"));
    assert.equal(open!.opensDialog, true);
    assert.match(open!.candidates.find((c) => c.css === '#btn_bug_report_save_request')!.caution!, /2 elements in the source share id/);
    assert.equal(submit!.fields[0]!.what, 'Education Date');
    assert.equal(submit!.fields[0]!.date, true);
    assert.ok(submit!.candidates.some((c) => c.name === 'Ok'));
    assert.match(confirm!.what, /"Reset Education\?" with "Yes"/);
    // A GET that resets data is answered by the flow, never the real backend.
    assert.deepEqual(reset.guards, [{ method: 'GET', path: '/super-save/reset_education_manual', alias: 'reset_education_manual' }]);
  });

  test('the PR change: both ways to toggle Super Save reach it, with the conditions the PR added', () => {
    const all = journeys();
    const toDetails = all.filter((j) => j.leadsTo.some((t) => t.path === '/super-save/get_user_details'));
    const row = toDetails.find((j) => j.steps[0]!.row?.column === 'super_save_restriction' && j.steps.length === 2)!;
    const viaDialog = toDetails.find((j) => j.steps[0]!.row?.column === 'action_history' && j.steps.length === 3)!;
    assert.ok(row, 'a journey from the row switch');
    assert.ok(viaDialog, 'a journey through View History and the dialog switch');
    // From the row: the switch, then the confirmation.
    assert.deepEqual(row.steps.map((s) => s.action), ['click', 'confirm']);
    assert.match(row.steps[1]!.what, /confirm "Super Save" with "Yes"/);
    // Through the dialog: View History (opens it), the switch inside it, the confirmation.
    assert.match(viaDialog.steps[0]!.what, /"View History" in a table row \(column action_history\) - opens EducationHistoryDialog/);
    assert.equal(viaDialog.steps[1]!.scope, 'dialog');
    // The request is conditional on what the PR changed.
    const details = row.leadsTo.find((t) => t.path === '/super-save/get_user_details')!;
    assert.ok(details.conditions.some((c) => /handleOnSaveSuperSave: selectedUserForHistory\?\.user_email && selectedUserForHistory\?\.user_id/.test(c)), details.conditions.join(' | '));
    assert.ok(details.conditions.some((c) => /refresh: user\?\.user_email/.test(c)), details.conditions.join(' | '));
    // The status change itself is answered by the flow.
    assert.ok(row.guards.some((g) => g.alias === 'change_super_save_status' && g.method === 'POST'));
    // Opening the history dialog on its own is a journey too (its query runs when it opens).
    const open = all.find((j) => j.steps.length === 1 && j.steps[0]!.row?.column === 'action_history')!;
    assert.ok(open.leadsTo.some((t) => t.path === '/super-save/get_user_details'));
  });

  test('the flows module: one method per journey, candidates in order, unreliable ones left out', () => {
    const all = journeys();
    const source = renderFlowsModule('Education Management', all);
    assert.match(source, /export class EducationManagementFlows \{/);
    assert.match(source, /constructor\(readonly page: Page, readonly qa: Qa\) \{\}/);
    for (const j of all) assert.ok(source.includes(`async ${j.name}(opts: FlowOptions = {}): Promise<void>`), j.name);
    // The shared id is not offered to the runtime when a reliable candidate exists.
    const reset = all.find((j) => j.leadsTo.some((t) => t.path === '/super-save/reset_education_manual'))!;
    const flows = JSON.parse(source.slice(source.indexOf('= {') + 2, source.indexOf('};\n\nexport class') + 1));
    assert.ok(!JSON.stringify(flows[reset.name].steps[0].candidates).includes('btn_bug_report_save_request'));
    // The proof waits for what a journey always sends, not what depends on a condition.
    const proof = renderProofSpec([{ key: 'education-management', name: 'Education Management', journeys: all }]);
    assert.match(proof, new RegExp(`flow: education-management\\.${reset.name}[\\s\\S]*?expectRequestMade\\("reset_education_manual"\\)`));
    assert.doesNotMatch(proof, /expectRequestMade\("get_user_details"\)[\s\S]*superSaveInRowConfirm|superSaveInRowConfirm\(\);\n  await qa\.expectRequestMade\("get_user_details"\)/);
  });

  test('preflight: a test must call the flow that leads to what it expects; the flow\'s aliases may be asserted', () => {
    const all = journeys();
    const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-journeys-suite-'));
    fs.mkdirSync(path.join(suite, 'pages'), { recursive: true });
    fs.mkdirSync(path.join(suite, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(suite, 'support'), { recursive: true });
    fs.writeFileSync(path.join(suite, 'support', 'qa.ts'), 'export {};\n');
    fs.writeFileSync(path.join(suite, 'pages', 'education-management.flows.ts'), renderFlowsModule('Education Management', all));
    const ctx = { suiteRoot: suite, pageObjects: readPageObjects(path.join(suite, 'pages')), qaHelpers: QA_HELPERS, scenarios: {}, changedTerms: [], triggers: recipeTriggers(all) };
    const row = all.find((j) => j.steps[0]!.row?.column === 'super_save_restriction' && j.steps.length === 2)!;
    const reset = all.find((j) => j.leadsTo.some((t) => t.path === '/super-save/reset_education_manual'))!;
    const spec = (body: string) => `import { test, expect } from '../support/qa';
import { EducationManagementFlows } from '../pages/education-management.flows';
test('[SC-545] Changing Super Save status from a row does not refresh the history dialog', async ({ page, qa }) => {
  // strategy: UI_AND_NETWORK
  const educationManagementFlows = new EducationManagementFlows(page, qa);
${body}
});`;
    // Expects the details request with no journey: blocked, told which flows lead there.
    const [idle] = preflightSpec('tests/e.spec.ts', spec(`  qa.observe('details', 'GET', '/super-save/get_user_details');
  await page.goto('/education-management');
  await qa.expectRequestNotMade('details');`), ctx).tests;
    assert.equal(idle!.executable, false);
    assert.ok(idle!.problems.some((p) => p.includes(row.name)), idle!.problems.join(' | '));

    // The PR's condition, verified: the row journey, the flow's alias asserted, details NOT requested.
    const [good] = preflightSpec('tests/e.spec.ts', spec(`  qa.observe('details', 'GET', '/super-save/get_user_details');
  await educationManagementFlows.${row.name}();
  await qa.expectRequestMade('change_super_save_status');
  await qa.expectRequestNotMade('details');`), ctx).tests;
    assert.deepEqual(good!.problems, []);
    assert.equal(good!.executable, true);

    // Calling a flow that does not lead to what the test expects.
    const [wrong] = preflightSpec('tests/e.spec.ts', spec(`  qa.observe('details', 'GET', '/super-save/get_user_details');
  await educationManagementFlows.${reset.name}();
  await qa.expectRequestMade('details');`), ctx).tests;
    assert.ok(wrong!.problems.some((p) => /none of the flows it calls/.test(p)), wrong!.problems.join(' | '));
    fs.rmSync(suite, { recursive: true, force: true });
  });

  test('the prompt lists each journey as a call, what it leads to, and under which condition', () => {
    const text = renderRecipes(journeys(), 'educationManagementFlows');
    assert.match(text, /educationManagementFlows\.\w+\(\)\s+\[not yet run\] - starts on \/education-management/);
    assert.match(text, /GET \/super-save\/get_user_details \(alias "get_user_details"\) - only if handleOnSaveSuperSave: selectedUserForHistory\?\.user_email && selectedUserForHistory\?\.user_id/);
    assert.match(text, /answered by the flow, never sent to the real backend: POST \/super-save\/change_super_save_status -> alias "change_super_save_status"/);
  });

  test('whether each journey sends a conditional request, worked out from the state its steps set', () => {
    const all = journeys();
    const outcome = (pred: (j: (typeof all)[number]) => boolean) => all.find(pred)!.leadsTo.find((t) => t.path === '/super-save/get_user_details')!.expected!;
    // From the row: nothing sets selectedUserForHistory, so the PR's check skips the refresh.
    const row = outcome((j) => j.steps[0]!.row?.column === 'super_save_restriction' && j.steps.length === 2);
    assert.equal(row.sent, false);
    assert.match(row.why, /nothing in this journey sets selectedUserForHistory/);
    // Through View History: handleViewHistory sets it, so the refresh is sent.
    const dialog = outcome((j) => j.steps[0]!.row?.column === 'action_history' && j.steps.length === 3);
    assert.equal(dialog.sent, true);
    assert.match(dialog.why, /selectedUserForHistory is set by handleViewHistory \("View History"\)/);
  });

  test('a module that only renders the changed dialog: its journey starts on its own page, opened through a real link', () => {
    const tab = buildRecipes(repo, [DIALOG], discoverApiEvidence(repo, [DIALOG]), '/users/user-details', [TAB, DIALOG], ['/education-management']);
    const open = tab.find((j) => j.steps[0]!.what.includes('Check Education History'))!;
    assert.ok(open, tab.map((j) => j.name).join(', '));
    // The dialog is opened inline (onClick={() => ref.current?.open()}).
    assert.match(open.steps[0]!.what, /opens EducationHistoryDialog/);
    assert.equal(open.route, '/users/user-details');
    // The page needs ?email=: it is opened through the Education Management page's link to it.
    assert.deepEqual(open.entry, { via: '/education-management', link: '/users/user-details' });
    // The parent fills the dialog's user, so its query runs.
    assert.equal(open.leadsTo.find((t) => t.path === '/super-save/get_user_details')!.expected!.sent, true);
    // Only the module's own journeys: none starting on Education Management.
    assert.ok(tab.every((j) => j.file === TAB));
  });

  test('preflight: a test asserting the opposite of what the code does in its journey, or not asserting the condition at all, is blocked', () => {
    const all = journeys();
    const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-journeys-suite-'));
    for (const d of ['pages', 'tests', 'support']) fs.mkdirSync(path.join(suite, d), { recursive: true });
    fs.writeFileSync(path.join(suite, 'support', 'qa.ts'), 'export {};\n');
    fs.writeFileSync(path.join(suite, 'pages', 'education-management.flows.ts'), renderFlowsModule('Education Management', all));
    const scenarios = { 'SC-579': { title: 'handleOnSaveSuperSave executes the history dialog refresh when user_email and user_id are present' } };
    const ctx = { suiteRoot: suite, pageObjects: readPageObjects(path.join(suite, 'pages')), qaHelpers: QA_HELPERS, scenarios, changedTerms: [], triggers: recipeTriggers(all) };
    const row = all.find((j) => j.steps[0]!.row?.column === 'super_save_restriction' && j.steps.length === 2)!;
    const viaDialog = all.find((j) => j.steps[0]!.row?.column === 'action_history' && j.steps.length === 3)!;
    const spec = (body: string) => `import { test, expect } from '../support/qa';
import { EducationManagementFlows } from '../pages/education-management.flows';
test('[SC-579] handleOnSaveSuperSave executes the history dialog refresh when user_email and user_id are present', async ({ page, qa }) => {
  // strategy: UI_AND_NETWORK
  const educationManagementFlows = new EducationManagementFlows(page, qa);
${body}
});`;
    // The refresh expected after the row journey, where the code never sends it.
    const [wrongJourney] = preflightSpec('tests/e.spec.ts', spec(`  qa.observe('details', 'GET', '/super-save/get_user_details');
  await educationManagementFlows.${row.name}();
  await qa.expectRequestMadeAfterFlow('details');`), ctx).tests;
    assert.equal(wrongJourney!.executable, false);
    assert.ok(wrongJourney!.problems.some((p) => p.includes(`requested after ${row.name}`) && p.includes(viaDialog.name)), wrongJourney!.problems.join(' | '));
    // Only the list refetch asserted: the condition the scenario is about is never checked.
    const [weak] = preflightSpec('tests/e.spec.ts', spec(`  await educationManagementFlows.${viaDialog.name}();
  await qa.expectRequestMade('change_super_save_status');`), ctx).tests;
    assert.ok(weak!.problems.some((p) => /The scenario is about the condition on handleOnSaveSuperSave/.test(p)), weak!.problems.join(' | '));
    assert.equal(weak!.executable, false);
    // Right journey, right assertion.
    const [good] = preflightSpec('tests/e.spec.ts', spec(`  qa.observe('details', 'GET', '/super-save/get_user_details');
  await educationManagementFlows.${viaDialog.name}();
  await qa.expectRequestMadeAfterFlow('details');`), ctx).tests;
    assert.deepEqual(good!.problems, []);
    fs.rmSync(suite, { recursive: true, force: true });
  });

  test('a condition scenario the generator could not cover is written from the journeys', () => {
    const triggers = recipeTriggers(journeys());
    const skip = synthesizeConditionTest('handleOnSaveSuperSave skips the history dialog refresh when user_email or user_id is missing', triggers, 'educationManagementFlows')!;
    assert.equal(skip.sent, false);
    assert.match(skip.flow, /^superSaveInRow/);
    assert.match(skip.body, /qa\.observe\('observed_get_user_details', 'GET', '\/super-save\/get_user_details'\);/);
    assert.match(skip.body, new RegExp(`await educationManagementFlows\\.${skip.flow}\\(\\);\\nawait qa\\.expectRequestNotMadeAfterFlow\\('observed_get_user_details'\\);`));
    const run = synthesizeConditionTest('handleOnSaveSuperSave executes the history dialog refresh when user_email and user_id are present', triggers, 'educationManagementFlows')!;
    assert.equal(run.sent, true);
    assert.match(run.flow, /^viewHistoryInRow.+/);
    assert.match(run.body, /expectRequestMadeAfterFlow\('observed_get_user_details'\)/);
    // Nothing about a traced condition: nothing is written.
    assert.equal(synthesizeConditionTest('Reset Education shows an error toast', triggers, 'educationManagementFlows'), null);
  });

  test('a module that does not own the changed dialog still gets the journeys through it', () => {
    // As in the real review: the dialog is assigned to another module; Education Management owns the page only.
    const own = buildRecipes(repo, FILES, discoverApiEvidence(repo, FILES), '/education-management', [PAGE]);
    const row = own.find((j) => j.steps[0]!.row?.column === 'super_save_restriction' && j.steps.length === 2)!;
    const details = row.leadsTo.find((t) => t.path === '/super-save/get_user_details');
    assert.ok(details, 'the dialog\'s refresh request is reached from the page');
    assert.equal(details!.expected!.sent, false);
    assert.ok(own.every((j) => j.file === PAGE));
  });
});
