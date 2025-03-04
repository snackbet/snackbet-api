import {
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/config/prisma/prisma.service';
import { AuthAccountRequestDto } from './dtos/authAccount-request.dto';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { Response } from 'express';
import { CommonResponseDto } from 'src/common/dtos/common-response.dto';
import { AccountResponseDto } from './dtos/account-response.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AccountService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async createAccountNonce() {
    const nonce = Math.random().toString(36).substring(2);

    await this.cacheManager.set(nonce, true);

    return nonce;
  }

  async authAccount(dto: AuthAccountRequestDto, res: Response) {
    const { publicKey, signature, nonce } = dto;

    const cachedNonce = await this.cacheManager.get(nonce);
    if (cachedNonce === undefined) {
      throw new UnauthorizedException('Invalid Request');
    }
    await this.cacheManager.del(nonce);

    try {
      // 1. signature (base64 or hex) 디코딩
      // Phantom에서 넘어오는 값이 base64라면 bs58 디코딩이 아니라
      // Buffer.from(signature, 'base64')를 사용해야 합니다.
      // Phantom signMessage에서 전달되는 signature는 기본적으로 base64입니다.
      const signatureUint8 = new Uint8Array(Buffer.from(signature, 'base64'));

      // 2. publicKey 디코딩
      // Phantom에서 resp.publicKey.toString() 한 값은 base58 형식이므로 bs58 디코딩
      const publicKeyUint8 = bs58.decode(publicKey);
      const pubKey = new PublicKey(publicKeyUint8);

      // 3. Nonce를 다시 Uint8Array로
      const messageUint8 = new TextEncoder().encode(nonce);

      // 4. TweetNacl을 이용한 서명 검증
      const verified = nacl.sign.detached.verify(
        messageUint8, // 원본 메시지
        signatureUint8, // 서명
        pubKey.toBytes(), // 공개키
      );

      if (!verified) {
        throw new UnauthorizedException('Signature verification failed');
      }

      // 여기서 verified == true라면 => 해당 publicKey의 개인키 소유자가 맞음
      // 이 시점에서 JWT 발급, 세션 생성 등의 로직을 추가하면 됨

      let account = await this.prismaService.account.findUnique({
        where: {
          walletAddress: publicKey,
        },
      });

      if (!account) {
        account = await this.prismaService.account.create({
          data: {
            id: uuidv4(),
            walletAddress: publicKey,
          },
        });
      }

      res
        .cookie(
          'snackbet_web_token',
          this.jwtService.sign({ sub: account.id }),
          { sameSite: 'none', secure: true, httpOnly: true },
        )
        .send(new CommonResponseDto(new AccountResponseDto(account.id)));
      return;
    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Internal Server Error');
    }
  }
}
