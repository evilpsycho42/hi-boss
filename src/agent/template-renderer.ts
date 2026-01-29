/**
 * Template rendering utilities for agent instructions.
 *
 * Loads templates from prompts/ and renders them with variable substitution.
 * All template variables use {{varName}} syntax.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { detectAttachmentType } from "../adapters/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Attachment type for rendering.
 */
export interface RenderableAttachment {
  source: string;
  filename?: string;
  type?: string;
}

/**
 * Get the instructions directory path.
 */
function getInstructionsDir(): string {
  // Navigate from dist/src/agent/ to prompts/
  return path.join(__dirname, "..", "..", "..", "prompts");
}

/**
 * Load a template from prompts/{templatePath}.md
 *
 * @param templatePath - Path relative to prompts (without .md extension)
 * @returns The template content
 * @throws Error if template doesn't exist
 */
export function loadTemplate(templatePath: string): string {
  const fullPath = path.join(getInstructionsDir(), `${templatePath}.md`);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Template not found: ${templatePath} (looked at: ${fullPath})`);
  }

  return fs.readFileSync(fullPath, "utf-8");
}

/**
 * Render a template with variable substitution.
 *
 * All values in the vars object must be strings. Use renderAttachments()
 * to pre-render attachment arrays before passing them.
 *
 * @param template - Template string with {{varName}} placeholders
 * @param vars - Object mapping variable names to string values
 * @returns Rendered template
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  const placeholderRegex = /\{\{\s*([^{}]+?)\s*\}\}/g;

  const placeholders = new Set<string>();
  for (const match of template.matchAll(placeholderRegex)) {
    placeholders.add(match[1].trim());
  }

  const missing = [...placeholders].filter((key) => vars[key] === undefined);
  if (missing.length > 0) {
    const missingPlaceholders = missing.map((k) => `{{${k}}}`).join(", ");
    const providedKeys = Object.keys(vars).sort().join(", ") || "(none)";
    throw new Error(
      `Missing template variables: ${missingPlaceholders} (provided: ${providedKeys})`
    );
  }

  return template.replace(placeholderRegex, (_match, rawKey) => {
    const key = String(rawKey).trim();
    return vars[key]!;
  });
}

function displayAttachmentName(att: RenderableAttachment): string | undefined {
  if (att.filename) return att.filename;

  try {
    const url = new URL(att.source);
    const base = path.posix.basename(url.pathname);
    return base || undefined;
  } catch {
    // Not a URL; treat as local path
  }

  return path.basename(att.source) || undefined;
}

/**
 * Render attachments array to text format.
 *
 * Format:
 * - [image] photo.jpg (https://...)
 * - [file] report.pdf (/path/to/report.pdf)
 *
 * @param attachments - Array of attachments
 * @returns Formatted string representation
 */
export function renderAttachments(
  attachments: RenderableAttachment[] | undefined
): string {
  if (!attachments?.length) {
    return "(none)";
  }

  return attachments
    .map((a) => {
      const type = detectAttachmentType({ source: a.source, filename: a.filename });
      const name = displayAttachmentName(a);
      if (!name || name === a.source) {
        return `- [${type}] ${a.source}`;
      }
      return `- [${type}] ${name} (${a.source})`;
    })
    .join("\n");
}

/**
 * Load and render a template in one step.
 *
 * @param templatePath - Path relative to prompts
 * @param vars - Variables to substitute
 * @returns Rendered template
 */
export function loadAndRender(
  templatePath: string,
  vars: Record<string, string>
): string {
  const template = loadTemplate(templatePath);
  try {
    return renderTemplate(template, vars);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to render template: ${templatePath}: ${message}`, {
      cause: error,
    });
  }
}
