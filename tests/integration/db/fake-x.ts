import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface StoredTweet {
  id: string;
  text: string;
  created_at: string;
  attachments?: {
    media_keys?: string[];
  };
}

export class FakeXServer {
  private server?: Server;
  public port = 0;
  public baseUrl = '';

  public recorded: RecordedRequest[] = [];
  public tweets: StoredTweet[] = [];
  private tweetCounter = 1000;
  private mediaCounter = 500;

  public failNextCreate?: { status: number; body: unknown };
  public hangNextCreate = false;
  public acceptThenHangNextCreate = false;
  public failNextUpload?: { status: number; body: unknown };
  public failNextLookup?: { status: number; body: unknown };
  public rateLimitNextCreate?: { resetEpoch: number };

  reset(): void {
    this.recorded = [];
    this.tweets = [];
    this.failNextCreate = undefined;
    this.hangNextCreate = false;
    this.acceptThenHangNextCreate = false;
    this.failNextUpload = undefined;
    this.failNextLookup = undefined;
    this.rateLimitNextCreate = undefined;
  }

  async start(): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Middleware to record all incoming requests
    app.use((req, _res, next) => {
      this.recorded.push({
        method: req.method,
        url: req.url,
        path: req.path,
        headers: req.headers,
        body: req.body,
      });
      next();
    });

    // 1. Media upload
    app.post('/2/media/upload', (_req: Request, res: Response) => {
      if (this.failNextUpload) {
        const fail = this.failNextUpload;
        this.failNextUpload = undefined;
        res.status(fail.status).json(fail.body);
        return;
      }
      this.mediaCounter++;
      res.status(200).json({ data: { id: `media-${this.mediaCounter}` } });
    });

    // 2. Media metadata
    app.post('/2/media/metadata', (_req: Request, res: Response) => {
      res.status(200).json({});
    });

    // 3. Create tweet
    app.post('/2/tweets', (req: Request, res: Response) => {
      if (this.rateLimitNextCreate) {
        const rl = this.rateLimitNextCreate;
        this.rateLimitNextCreate = undefined;
        res
          .status(429)
          .set('x-rate-limit-reset', String(rl.resetEpoch))
          .json({ title: 'Too Many Requests', detail: 'Rate limit exceeded' });
        return;
      }

      if (this.failNextCreate) {
        const fail = this.failNextCreate;
        this.failNextCreate = undefined;
        res.status(fail.status).json(fail.body);
        return;
      }

      if (this.hangNextCreate) {
        this.hangNextCreate = false;
        // Never answer; client will time out
        return;
      }

      this.tweetCounter++;
      const tweetId = `tweet-${this.tweetCounter}`;
      const mediaIds = (req.body?.media?.media_ids as string[]) ?? [];
      const newTweet: StoredTweet = {
        id: tweetId,
        text: req.body?.text ?? '',
        created_at: new Date().toISOString(),
        ...(mediaIds.length > 0 ? { attachments: { media_keys: mediaIds } } : {}),
      };
      this.tweets.unshift(newTweet);

      if (this.acceptThenHangNextCreate) {
        this.acceptThenHangNextCreate = false;
        // Store tweet, then hang without sending response
        return;
      }

      res.status(201).json({
        data: {
          id: tweetId,
          text: newTweet.text,
        },
      });
    });

    // 4. Timeline lookup
    app.get('/2/users/:userId/tweets', (req: Request, res: Response) => {
      if (this.failNextLookup) {
        const fail = this.failNextLookup;
        this.failNextLookup = undefined;
        res.status(fail.status).json(fail.body);
        return;
      }

      const sinceParam = req.query.start_time as string | undefined;
      let matched = this.tweets;
      if (sinceParam) {
        const sinceTime = new Date(sinceParam).getTime();
        matched = this.tweets.filter((t) => new Date(t.created_at).getTime() >= sinceTime);
      }

      res.status(200).json({
        data: matched,
        meta: { result_count: matched.length },
      });
    });

    // 5. Get status of one tweet
    app.get('/2/tweets/:id', (req: Request, res: Response) => {
      const tweet = this.tweets.find((t) => t.id === req.params.id);
      if (tweet) {
        res.status(200).json({ data: tweet });
      } else {
        res.status(404).json({
          errors: [
            { title: 'Not Found Error', detail: `Could not find tweet with id: ${req.params.id}` },
          ],
        });
      }
    });

    return new Promise((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => {
        const address = this.server?.address() as { port: number };
        this.port = address.port;
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        resolve(this.baseUrl);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
