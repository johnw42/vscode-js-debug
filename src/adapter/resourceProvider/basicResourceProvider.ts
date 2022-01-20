/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import dataUriToBuffer from 'data-uri-to-buffer';
import got, { Headers, OptionsOfTextResponseBody, RequestError } from 'got';
import { inject, injectable, optional } from 'inversify';
import { CancellationToken } from 'vscode';
import { HttpStatusError, IResourceProvider, Response } from '.';
import { NeverCancelled } from '../../common/cancellation';
import { DisposableList } from '../../common/disposable';
import { fileUrlToAbsolutePath, isAbsolute, isLoopback } from '../../common/urlUtils';
import { FS, FsPromises } from '../../ioc-extras';
import { IRequestOptionsProvider } from './requestOptionsProvider';

@injectable()
export class BasicResourceProvider implements IResourceProvider {
  constructor(
    @inject(FS) private readonly fs: FsPromises,
    @optional() @inject(IRequestOptionsProvider) private readonly options?: IRequestOptionsProvider,
  ) {}

  /**
   * @inheritdoc
   */
  public async fetch(
    url: string,
    cancellationToken: CancellationToken = NeverCancelled,
    headers?: { [key: string]: string },
  ): Promise<Response<string>> {
    try {
      const r = dataUriToBuffer(url);
      return { ok: true, url, body: r.toString('utf-8'), statusCode: 200 };
    } catch {
      // assume it's a remote url
    }

    const absolutePath = isAbsolute(url) ? url : fileUrlToAbsolutePath(url);
    if (absolutePath) {
      try {
        return {
          ok: true,
          url,
          body: await this.fs.readFile(absolutePath, 'utf-8'),
          statusCode: 200,
        };
      } catch (error) {
        return { ok: false, url, error, statusCode: 200 };
      }
    }

    return this.fetchHttp(url, cancellationToken, headers);
  }
  /**
   * Returns JSON from the given file, data, or HTTP URL.
   */
  public async fetchJson<T>(
    url: string,
    cancellationToken?: CancellationToken,
    headers?: { [key: string]: string },
  ): Promise<Response<T>> {
    const res = await this.fetch(url, cancellationToken, {
      Accept: 'application/json',
      ...headers,
    });
    if (!res.ok) {
      return res;
    }

    try {
      return { ...res, body: JSON.parse(res.body) };
    } catch (error) {
      return { ...res, ok: false, url, error };
    }
  }

  protected async fetchHttp(
    url: string,
    cancellationToken: CancellationToken,
    headers?: Headers,
  ): Promise<Response<string>> {
    const parsed = new URL(url);

    const isSecure = parsed.protocol !== 'http:';
    const options: OptionsOfTextResponseBody = { headers, followRedirect: true };
    if (isSecure && (await isLoopback(url))) {
      options.rejectUnauthorized = false;
    }

    this.options?.provideOptions(options, url);

    const response = await this.requestHttp(url, options, cancellationToken);

    // Try 127.0.0.1 if localhost fails, see https://github.com/microsoft/vscode/issues/140536#issuecomment-1011281962
    // The statusCode will be 503 on ECONNREFUSED
    if (response.statusCode === 503 && parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
      return this.requestHttp(parsed.toString(), options, cancellationToken);
    }

    return response;
  }

  private async requestHttp(
    url: string,
    options: OptionsOfTextResponseBody,
    cancellationToken: CancellationToken,
  ): Promise<Response<string>> {
    this.options?.provideOptions(options, url);

    const disposables = new DisposableList();

    try {
      const request = got(url, options);
      disposables.push(cancellationToken.onCancellationRequested(() => request.cancel()));

      const response = await request;
      return { ok: true, url, body: response.body, statusCode: response.statusCode };
    } catch (error) {
      if (!(error instanceof RequestError)) {
        throw error;
      }

      const body = error.response ? String(error.response?.body) : error.message;
      const statusCode = error.response?.statusCode ?? 503;
      return {
        ok: false,
        body,
        statusCode,
        url,
        error: new HttpStatusError(statusCode, url, body),
      };
    } finally {
      disposables.dispose();
    }
  }
}
