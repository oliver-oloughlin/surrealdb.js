import {
	type LiveQueryResponse,
	type RawSocketLiveQueryNotification,
	type RawSocketMessageResponse,
	type Result,
	type StatusHooks,
	type UnprocessedLiveQueryResponse,
	WebsocketStatus,
} from "../types.ts";
import WebSocket from "./WebSocket/deno.ts";
import { getIncrementalID } from "./getIncrementalID.ts";
import { processUrl } from "./processUrl.ts";

export class SurrealSocket {
	private url: string;
	private readonly hooks: StatusHooks;
	private ws?: WebSocket;
	private status: WebsocketStatus = WebsocketStatus.CLOSED;
	private queue: Record<string, (data: Result) => unknown> = {};
	private liveQueue: Record<
		string,
		((data: LiveQueryResponse) => unknown)[]
	> = {};

	private unprocessedLiveResponses: Record<string, LiveQueryResponse[]> = {};

	public ready?: Promise<void>;
	public closed?: Promise<void>;
	private resolveClosed?: () => void;

	public socketClosureReason: Record<number, string> = {
		1000: "CLOSE_NORMAL",
	};

	constructor({
		url,
		onConnect,
		onClose,
		onError,
	}: {
		url: string;
	} & StatusHooks) {
		this.hooks = { onConnect, onClose, onError };
		this.url = processUrl(url, {
			http: "ws",
			https: "wss",
		}) + "/rpc";
	}

	open() {
		// Close any possibly connected sockets, reset status;
		this.close(1000);

		// Connect to Surreal instance
		let resolved = false;
		const ws = new WebSocket(this.url);
		this.ready = new Promise((resolve, reject) => {
			ws.addEventListener("open", (_e) => {
				this.status = WebsocketStatus.OPEN;
				if (!resolved) {
					resolved = true;
					resolve();
				}

				this.hooks.onConnect?.();
			});

			ws.addEventListener("error", (e) => {
				this.status = WebsocketStatus.CLOSED;
				if (!resolved) {
					resolved = true;
					reject("error" in e ? e.error : e.toString());
					this.hooks.onError?.();
				}
			});
		});

		ws.addEventListener("close", (_e) => {
			this.resolveClosed?.();

			Object.values(this.liveQueue).map((query) => {
				query.map((cb) =>
					cb({
						action: "CLOSE",
						detail: "SOCKET_CLOSED",
					})
				);
			});

			this.queue = {};
			this.liveQueue = {};
			this.unprocessedLiveResponses = {};

			// Connection retry mechanism
			if (this.status !== WebsocketStatus.CLOSED) {
				this.status = WebsocketStatus.RECONNECTING;

				setTimeout(() => {
					this.open();
				}, 2500);

				this.hooks.onClose?.();
			}
		});

		ws.addEventListener("message", (e) => {
			const res = JSON.parse(
				e.data.toString(),
			) as RawSocketMessageResponse;
			if (SurrealSocket.isLiveNotification(res)) {
				this.handleLiveBatch(res.result);
			} else if (res.id && res.id in this.queue) {
				this.queue[res.id](res);
				delete this.queue[res.id];
			}
		});

		this.ws = ws;
		return this.ready;
	}

	// Extracting the pure object to prevent any getters/setters that could break stuff
	// Prevent user from overwriting ID that is being sent
	async send(
		method: string,
		params: unknown[],
	) {
		await this.ready;
		const { promise, resolve } = Promise.withResolvers<Result>();
		const id = getIncrementalID();
		this.queue[id] = (data) => resolve(data);
		this.ws?.send(JSON.stringify({ id, method, params }));
		return promise;
	}

	async listenLive(
		queryUuid: string,
		callback: (data: LiveQueryResponse) => unknown,
	) {
		if (!(queryUuid in this.liveQueue)) this.liveQueue[queryUuid] = [];
		this.liveQueue[queryUuid].push(callback);

		// Cleanup unprocessed messages queue
		await Promise.all(
			this.unprocessedLiveResponses[queryUuid]?.map(callback) ?? [],
		);
		delete this.unprocessedLiveResponses[queryUuid];
	}

	async kill(queryUuid: string) {
		if (queryUuid in this.liveQueue) {
			this.liveQueue[queryUuid].forEach((cb) =>
				cb({
					action: "CLOSE",
					detail: "QUERY_KILLED",
				})
			);

			delete this.liveQueue[queryUuid];
		}

		await this.send("kill", [queryUuid]);
		if (queryUuid in this.unprocessedLiveResponses) {
			delete this.unprocessedLiveResponses[queryUuid];
		}
	}

	private async handleLiveBatch(
		{ id: queryUuid, ...message }: UnprocessedLiveQueryResponse,
	) {
		if (this.liveQueue[queryUuid]) {
			await Promise.all(
				this.liveQueue[queryUuid].map(async (cb) => await cb(message)),
			);
		} else {
			if (!(queryUuid in this.unprocessedLiveResponses)) {
				this.unprocessedLiveResponses[queryUuid] = [];
			}
			this.unprocessedLiveResponses[queryUuid].push(message);
		}
	}

	async close(reason: keyof typeof this.socketClosureReason) {
		this.status = WebsocketStatus.CLOSED;
		this.closed = new Promise((r) => this.resolveClosed = r);
		this.ws?.close(reason, this.socketClosureReason[reason]);
		this.hooks.onClose?.();
		await this.closed;
	}

	get connectionStatus() {
		return this.status;
	}

	public static isLiveNotification(
		message: Record<string, unknown>,
	): message is RawSocketLiveQueryNotification {
		return !!(
			!("id" in message) &&
			"result" in message &&
			typeof message.result === "object" &&
			message.result !== null &&
			"action" in message.result &&
			"id" in message.result &&
			"result" in message.result
		);
	}
}
