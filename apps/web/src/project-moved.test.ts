import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectMoved } from "./ProjectRouteBoundary.tsx";
import { projectMovedTarget } from "./project-moved.ts";

const user = {
  email: "ana@example.com",
  id: "u1",
  impersonating: false,
  isStaff: false,
  name: "Ana",
};
const project = {
  hasIngested: true,
  hasSentryIssues: false,
  id: "p1",
  name: "Alara",
  slug: "alara",
};

test("a project that moved sends its members to the workspace origin", () => {
  assert.equal(
    projectMovedTarget({
      project: { ...project, workspaceUrl: "https://us.superlog.sh/api/v1" },
      user,
    }),
    "https://us.superlog.sh/",
  );
});

test("a project that did not move stays", () => {
  assert.equal(projectMovedTarget({ project, user }), null);
  assert.equal(projectMovedTarget({ project: { ...project, workspaceUrl: null }, user }), null);
  assert.equal(projectMovedTarget(undefined), null);
});

test("staff impersonating a member stay, and only HTTPS origins are followed", () => {
  const moved = { ...project, workspaceUrl: "https://us.superlog.sh" };
  assert.equal(
    projectMovedTarget({ project: moved, user: { ...user, impersonating: true } }),
    null,
  );
  assert.equal(
    projectMovedTarget({ project: { ...project, workspaceUrl: "http://us.superlog.sh" }, user }),
    null,
  );
  assert.equal(
    projectMovedTarget({ project: { ...project, workspaceUrl: "not a url" }, user }),
    null,
  );
});

test("the notice names the project and links to the workspace", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectMoved, { projectName: "Alara", target: "https://us.superlog.sh/" }),
  );

  assert.match(html, /Alara moved to us\.superlog\.sh/);
  assert.match(html, /Open us\.superlog\.sh/);
});
