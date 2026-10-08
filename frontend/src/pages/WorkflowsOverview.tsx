import { listProjects, listWorkflows } from "../api";
import { formatTimestamp } from "../time";
import { useFetch } from "../useFetch";
import {
  stateLabel,
  lastFailureLabel,
  lastRunLabel,
  nextRunLabel,
  projectLabel,
  workflowHref,
} from "../workflowOverview";

/** `#/workflows`: every workflow across all projects in one table — project,
 * on/off, last run, last failure, next run. Global, above projects; a row opens
 * the workflow in its owning project's view. Mounted standalone at
 * `#/workflows` (an h1) and as the Library's Workflows tab (`embedded`, an h2
 * under the page's own h1). */
export function WorkflowsOverview({ embedded = false }: { embedded?: boolean }) {
  const { data: workflows, error } = useFetch(
    () => listWorkflows(),
    "workflows-overview",
    {
      pollMs: 5000,
    },
  );
  const { data: projects } = useFetch(
    () => listProjects(),
    "workflows-overview-projects",
  );

  return (
    <div className="workflows-overview">
      {embedded ? <h2>Workflows</h2> : <h1>Workflows</h1>}
      <p className="muted">
        Every workflow across all projects. A workflow that is on fires from its
        trigger (a time one runs on the server's timer); off, it only runs when
        asked.
      </p>
      {error ? (
        <p className="error">{error}</p>
      ) : !workflows || !projects ? (
        <p className="muted">Loading…</p>
      ) : workflows.length === 0 ? (
        <p className="muted">No workflows yet.</p>
      ) : (
        <div className="cc-table-wrap">
          <table className="cc-table">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Project</th>
                <th>On</th>
                <th>Last run</th>
                <th>Last failure</th>
                <th>Next run</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => {
                const href = workflowHref(w);
                return (
                  <tr key={w.id}>
                    <td>{href ? <a href={href}>{w.name}</a> : w.name}</td>
                    <td>{projectLabel(w, projects)}</td>
                    <td>{stateLabel(w)}</td>
                    <td
                      className={
                        w.last_run_status === "failed" ? "error" : undefined
                      }
                      title={
                        w.last_run_at
                          ? formatTimestamp(w.last_run_at)
                          : undefined
                      }
                    >
                      {lastRunLabel(w)}
                    </td>
                    <td
                      title={
                        w.last_failure_at
                          ? formatTimestamp(w.last_failure_at)
                          : undefined
                      }
                    >
                      {lastFailureLabel(w)}
                    </td>
                    <td
                      title={
                        w.next_run_at
                          ? formatTimestamp(w.next_run_at)
                          : undefined
                      }
                    >
                      {nextRunLabel(w)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
