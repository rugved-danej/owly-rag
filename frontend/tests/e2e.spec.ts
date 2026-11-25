import { test, expect } from "@playwright/test";

test("Owly RAG workspace renders, switches sessions, opens modals, and streams greeting via Next.js proxy", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByText("Owly RAG")).toBeVisible();
  await expect(page.getByText("Knowledge Base")).toBeVisible();
  await expect(page.getByPlaceholder(/Ask Owly anything/i)).toBeVisible();

  // Create a fresh isolated chat session via New Chat -> /chat/[sessionId]
  await page.getByRole("button", { name: "New Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/chat-/);
  await expect(
    page.getByRole("heading", { name: "Ask your documents anything" })
  ).toBeVisible();

  // Ctrl+K focuses Knowledge Base search input
  await page.keyboard.press("Control+k");
  await expect(page.locator("#kb-search-input")).toBeFocused();

  // Hardware modal opens and closes with Escape
  const hwBtn = page.locator("header button", { hasText: /qwen|ollama|llama|gemma/i }).first();
  if (await hwBtn.isVisible()) {
    await hwBtn.click();
    await expect(page.getByText("Smart Hardware & Model Manager")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Smart Hardware & Model Manager")).toBeHidden();
  }

  // Send greeting and verify SSE streamed Owly reply
  const input = page.getByPlaceholder(/Ask Owly anything/i);
  await input.fill("hi");
  await input.press("Enter");
  await expect(page.locator(".chat-prose").getByText(/I'm Owly/i).last()).toBeVisible({
    timeout: 15_000,
  });

  // Clean up test session via /clear
  await input.fill("/clear");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Ask your documents anything" })
  ).toBeVisible({ timeout: 10_000 });
});
