/** Envio de e-mail transacional por SMTP (ERP 18.14; Mailpit em desenvolvimento). Sempre fora de transação. */
import nodemailer, { type Transporter } from 'nodemailer';

export interface Email {
  para: string;
  assunto: string;
  texto: string;
  html?: string;
}

export class EnviadorEmail {
  private transporte: Transporter | null = null;

  constructor(private readonly opcoes: { smtpUrl: string; remetente: string }) {}

  async enviar(email: Email): Promise<void> {
    this.transporte ??= nodemailer.createTransport(this.opcoes.smtpUrl);
    await this.transporte.sendMail({
      from: this.opcoes.remetente,
      to: email.para,
      subject: email.assunto,
      text: email.texto,
      ...(email.html ? { html: email.html } : {}),
    });
  }

  fechar(): void {
    this.transporte?.close();
  }
}
