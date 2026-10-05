import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const { ip, ips } = req as { ip?: string; ips?: string[] };
    return ips?.length ? ips[0] : (ip ?? "");
  }
}
