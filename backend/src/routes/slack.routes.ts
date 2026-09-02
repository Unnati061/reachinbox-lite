import { Router } from 'express';
import { createSlackAuthorizationUrl, finishSlackOAuth } from '../services/slack.service.js';
import { z } from 'zod';

export const slackRouter = Router();

slackRouter.get('/connect', async (req, res) => {
  const { sender } = z.object({ sender: z.string().min(1) }).parse(req.query);
  res.redirect(await createSlackAuthorizationUrl(sender));
});

slackRouter.get('/callback', async (req, res) => {
  const { code, state, error } = z
    .object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    })
    .parse(req.query);
  if (error !== undefined) res.status(400).send(`Slack authorization was cancelled: ${error}`);
  else if (code === undefined || state === undefined)
    res.status(400).send('Slack callback is missing code or state.');
  else {
    await finishSlackOAuth(code, state);
    res
      .type('html')
      .send('<p>Slack connected. You may close this window and return to ReachInbox.</p>');
  }
});
