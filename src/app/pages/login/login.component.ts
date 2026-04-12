import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  pinDigits = signal<string[]>(['', '', '', '', '', '']);
  errorMessage = signal<string>('');
  isLoading = signal<boolean>(false);

  onDigitInput(event: Event, index: number): void {
    const input = event.target as HTMLInputElement;
    const value = input.value;

    if (value && !/^\d$/.test(value)) {
      input.value = '';
      return;
    }

    const digits = [...this.pinDigits()];
    digits[index] = value;
    this.pinDigits.set(digits);

    // Auto-focus next input
    if (value && index < 5) {
      const nextInput = document.getElementById(`pin-${index + 1}`) as HTMLInputElement;
      nextInput?.focus();
    }

    // Auto-submit when all 6 digits entered
    if (digits.every(d => d !== '')) {
      this.submitPin();
    }
  }

  onKeyDown(event: KeyboardEvent, index: number): void {
    if (event.key === 'Backspace') {
      const digits = [...this.pinDigits()];
      if (!digits[index] && index > 0) {
        const prevInput = document.getElementById(`pin-${index - 1}`) as HTMLInputElement;
        prevInput?.focus();
        digits[index - 1] = '';
        this.pinDigits.set(digits);
      } else {
        digits[index] = '';
        this.pinDigits.set(digits);
      }
      event.preventDefault();
    }
  }

  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const pasteData = event.clipboardData?.getData('text') || '';
    const digits = pasteData.replace(/\D/g, '').substring(0, 6).split('');
    if (digits.length === 6) {
      this.pinDigits.set(digits);
      const lastInput = document.getElementById('pin-5') as HTMLInputElement;
      lastInput?.focus();
      this.submitPin();
    }
  }

  submitPin(): void {
    const pin = this.pinDigits().join('');
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      this.errorMessage.set('Please enter all 6 digits.');
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set('');

    this.authService.login(pin).subscribe({
      next: (res) => {
        this.isLoading.set(false);
        if (res.success) {
          this.router.navigate(['/']);
        }
      },
      error: (err) => {
        this.isLoading.set(false);
        this.errorMessage.set(err.error?.error || 'Login failed. Please try again.');
        this.clearPin();
      },
    });
  }

  private clearPin(): void {
    this.pinDigits.set(['', '', '', '', '', '']);
    const firstInput = document.getElementById('pin-0') as HTMLInputElement;
    firstInput?.focus();
  }
}
