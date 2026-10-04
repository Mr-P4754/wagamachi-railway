/**
 * Web Audio API based Railway & City Audio Synthesizer
 * Fully procedural: no external asset files needed, completely reliable & offline.
 * 
 * ボイスリミッター（同時発音数制限）、距離カリング、ノード切断・解放管理を統合
 */

interface ActiveVoice {
  id: number;
  category: 'joint' | 'se';
  startTime: number;
  volume: number;
  gainNode?: GainNode;
  nodes: Array<AudioNode | { stop?: () => void; disconnect: () => void }>;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private masterGain: GainNode | null = null;

  private noiseBuffer: AudioBuffer | null = null;
  private cabMotorOsc: OscillatorNode | null = null;
  private cabMotorGain: GainNode | null = null;
  private cabRumbleSource: AudioBufferSourceNode | null = null;
  private cabRumbleGain: GainNode | null = null;
  private isCabActive: boolean = false;

  // ボイスリミッター（同時発音数制限）
  private static readonly MAX_TOTAL_VOICES = 8;
  private static readonly MAX_JOINT_VOICES = 3;
  private nextVoiceId = 1;
  private activeVoices: Map<number, ActiveVoice> = new Map();

  constructor() {
    // AudioContext will be initialized on first user interaction
  }

  private initContext() {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : 0.3, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
      this.createNoiseBuffer();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * ボイス枠の取得・上限管理
   * 上限に達している場合は優先度の低い音（最古または音量の小さいもの）を短時間フェードアウト停止して入れ替える
   */
  private acquireVoice(category: 'joint' | 'se', volume: number): number | null {
    if (!this.ctx || volume < 0.005) return null;

    // 1. カテゴリごとの上限チェック（走行ジョイント音）
    if (category === 'joint') {
      const jointVoices: ActiveVoice[] = [];
      for (const v of this.activeVoices.values()) {
        if (v.category === 'joint') jointVoices.push(v);
      }
      if (jointVoices.length >= AudioManager.MAX_JOINT_VOICES) {
        jointVoices.sort((a, b) => a.startTime - b.startTime);
        const oldest = jointVoices[0];
        this.terminateVoice(oldest, 0.015);
      }
    }

    // 2. 全体の同時発音数上限チェック
    if (this.activeVoices.size >= AudioManager.MAX_TOTAL_VOICES) {
      const all = Array.from(this.activeVoices.values());
      all.sort((a, b) => {
        // ジョイント音を優先して停止（SEを維持）
        if (a.category !== b.category) {
          return a.category === 'joint' ? -1 : 1;
        }
        // 音量が小さい方を優先停止
        if (Math.abs(a.volume - b.volume) > 0.05) {
          return a.volume - b.volume;
        }
        // 最も古い発音を優先停止
        return a.startTime - b.startTime;
      });

      const victim = all[0];
      this.terminateVoice(victim, 0.015);
    }

    // 枠が空かない場合はスキップ
    if (this.activeVoices.size >= AudioManager.MAX_TOTAL_VOICES) {
      return null;
    }

    return this.nextVoiceId++;
  }

  /**
   * ボイスの登録
   */
  private registerVoice(voiceId: number, voice: ActiveVoice): void {
    this.activeVoices.set(voiceId, voice);
  }

  /**
   * ボイスの強制フェードアウト停止・ノード切断
   */
  private terminateVoice(voice: ActiveVoice, fadeSec: number = 0.015): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      if (voice.gainNode) {
        voice.gainNode.gain.cancelScheduledValues(now);
        voice.gainNode.gain.setValueAtTime(voice.gainNode.gain.value, now);
        voice.gainNode.gain.linearRampToValueAtTime(0.0001, now + fadeSec);
      }
      setTimeout(() => {
        for (const node of voice.nodes) {
          try {
            if ('stop' in node && typeof (node as any).stop === 'function') {
              (node as any).stop();
            }
            node.disconnect();
          } catch (_) {}
        }
        this.activeVoices.delete(voice.id);
      }, fadeSec * 1000 + 10);
    } catch (_) {
      this.activeVoices.delete(voice.id);
    }
  }

  /**
   * 再生完了時のボイス解放
   */
  private releaseVoice(voiceId: number): void {
    this.activeVoices.delete(voiceId);
  }

  /**
   * 前面展望中かどうかの取得
   */
  public getIsCabActive(): boolean {
    return this.isCabActive;
  }

  /**
   * プロシージャル合成用ホワイトノイズバッファ（外部ファイル不要）
   */
  private createNoiseBuffer() {
    if (!this.ctx || this.noiseBuffer) return;
    const bufferSize = this.ctx.sampleRate * 1.0; // 1秒分
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
  }

  public toggleMute(): boolean {
    this.initContext();
    this.isMuted = !this.isMuted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : 0.3, this.ctx.currentTime);
    }
    return this.isMuted;
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  /**
   * 走行ジョイント音（ガタゴト音）
   * @param speedFactor 列車速度係数 (1.0〜3.0)
   * @param environment 'normal' | 'bridge' | 'tunnel'
   * @param isSwitch 分岐器（ポイント）通過中かどうか
   * @param distanceFactor 3D空間音響（カメラ距離に応じた 0.0〜1.0 の音量減衰）
   */
  public playJointSound(
    speedFactor: number = 1.0,
    environment: 'normal' | 'bridge' | 'tunnel' = 'normal',
    isSwitch: boolean = false,
    distanceFactor: number = 1.0
  ) {
    // 距離カリング: 0.04未満の場合はノードを生成せず早期リターン
    if (this.isMuted || distanceFactor < 0.04) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const t = this.ctx.currentTime;
    const basePitch = 100 * Math.min(1.4, Math.max(0.8, Math.pow(speedFactor, 0.35)));

    // 環境に応じたフィルター特性
    // 鉄橋: 金属反響（バンドパスで中低域強調・レゾナンス高め）
    // トンネル: こもった低域（ローパス320Hz＋暗い残響）
    // 通常: 自然な低域（ローパス480Hz）
    const playClick = (offset: number, pitch: number, vol: number) => {
      if (!this.ctx || !this.masterGain) return;
      const effectiveVol = vol * 0.4 * Math.min(1.0, distanceFactor);
      if (effectiveVol < 0.005) return;

      const voiceId = this.acquireVoice('joint', effectiveVol);
      if (voiceId === null) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();

      if (environment === 'bridge') {
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(220, t + offset);
        filter.Q.setValueAtTime(4.5, t + offset); // 金属トラス共振
      } else if (environment === 'tunnel') {
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(320, t + offset);
        filter.Q.setValueAtTime(1.0, t + offset);
      } else {
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(480, t + offset);
      }

      osc.type = environment === 'bridge' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(pitch, t + offset);
      osc.frequency.exponentialRampToValueAtTime(environment === 'bridge' ? 45 : 30, t + offset + 0.06);

      gain.gain.setValueAtTime(effectiveVol, t + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.08);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);

      let echoGain: GainNode | null = null;
      // トンネル内の反響ディレイ音（閉塞空間リバーブ）
      if (environment === 'tunnel') {
        echoGain = this.ctx.createGain();
        echoGain.gain.setValueAtTime(effectiveVol * 0.4, t + offset + 0.045);
        echoGain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.12);
        filter.connect(echoGain);
        echoGain.connect(this.masterGain);
      }

      const nodes: AudioNode[] = [osc, filter, gain];
      if (echoGain) nodes.push(echoGain);

      this.registerVoice(voiceId, {
        id: voiceId,
        category: 'joint',
        startTime: t + offset,
        volume: effectiveVol,
        gainNode: gain,
        nodes
      });

      osc.onended = () => {
        for (const n of nodes) {
          try { n.disconnect(); } catch (_) {}
        }
        this.releaseVoice(voiceId);
      };

      osc.start(t + offset);
      osc.stop(t + offset + 0.09);
    };

    // 前台車
    playClick(0.0, basePitch * 1.1, 0.75);
    playClick(0.065 / Math.max(0.6, speedFactor), basePitch * 1.0, 0.9);

    // 後台車（速度に応じてボギー間間隔が短縮）
    const rearDelay = 0.22 / Math.max(0.4, speedFactor);
    playClick(rearDelay, basePitch * 1.05, 0.65);
    playClick(rearDelay + (0.065 / Math.max(0.6, speedFactor)), basePitch * 0.95, 0.8);

    // 分岐器通過時の専用通過音（ポイント隙間とフランジの金属打撃音）
    if (isSwitch) {
      this.playSwitchClack(t + 0.03, distanceFactor);
    }
  }

  /**
   * 分岐器（ポイント）通過時の金属フランジ通過音
   */
  private playSwitchClack(t: number, distanceFactor: number) {
    if (this.isMuted || distanceFactor < 0.04) return;
    if (!this.ctx || !this.masterGain) return;

    const vol = 0.25 * Math.min(1.0, distanceFactor);
    if (vol < 0.005) return;

    const voiceId = this.acquireVoice('joint', vol);
    if (voiceId === null) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'square';
    osc.frequency.setValueAtTime(650, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.04);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(550, t);
    filter.Q.setValueAtTime(3.0, t);

    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    const nodes: AudioNode[] = [osc, filter, gain];
    this.registerVoice(voiceId, {
      id: voiceId,
      category: 'joint',
      startTime: t,
      volume: vol,
      gainNode: gain,
      nodes
    });

    osc.onended = () => {
      for (const n of nodes) {
        try { n.disconnect(); } catch (_) {}
      }
      this.releaseVoice(voiceId);
    };

    osc.start(t);
    osc.stop(t + 0.06);
  }

  /**
   * 車両連結音（ガチャン！重厚な密着連結器の金属衝撃音）
   */
  public playCouplingSound(distanceFactor: number = 1.0) {
    if (this.isMuted || distanceFactor < 0.04) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const t = this.ctx.currentTime;
    const vol = 0.5 * Math.min(1.0, distanceFactor);
    if (vol < 0.005) return;

    const voiceId = this.acquireVoice('se', vol);
    if (voiceId === null) return;

    const nodesToDisconnect: AudioNode[] = [];

    // 1. 低周波の重厚な打撃衝撃波
    const oscImpact = this.ctx.createOscillator();
    const gainImpact = this.ctx.createGain();
    oscImpact.type = 'triangle';
    oscImpact.frequency.setValueAtTime(140, t);
    oscImpact.frequency.exponentialRampToValueAtTime(35, t + 0.12);

    gainImpact.gain.setValueAtTime(vol * 0.8, t);
    gainImpact.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

    oscImpact.connect(gainImpact);
    gainImpact.connect(this.masterGain);
    nodesToDisconnect.push(oscImpact, gainImpact);

    oscImpact.start(t);
    oscImpact.stop(t + 0.15);

    // 2. 金属の激突バースト（ノイズ＋バンドパス）
    if (this.noiseBuffer) {
      const noiseSource = this.ctx.createBufferSource();
      noiseSource.buffer = this.noiseBuffer;
      const noiseFilter = this.ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.setValueAtTime(1400, t);
      noiseFilter.Q.setValueAtTime(2.5, t);

      const noiseGain = this.ctx.createGain();
      noiseGain.gain.setValueAtTime(vol * 0.7, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);

      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.masterGain);
      nodesToDisconnect.push(noiseSource, noiseFilter, noiseGain);

      noiseSource.start(t);
      noiseSource.stop(t + 0.1);
    }

    // 3. 余韻の金属チャタリング（ガチャリ）
    const oscRing = this.ctx.createOscillator();
    const gainRing = this.ctx.createGain();
    oscRing.type = 'sawtooth';
    oscRing.frequency.setValueAtTime(820, t + 0.02);
    oscRing.frequency.exponentialRampToValueAtTime(220, t + 0.18);

    gainRing.gain.setValueAtTime(0, t);
    gainRing.gain.setValueAtTime(vol * 0.4, t + 0.02);
    gainRing.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

    oscRing.connect(gainRing);
    gainRing.connect(this.masterGain);
    nodesToDisconnect.push(oscRing, gainRing);

    this.registerVoice(voiceId, {
      id: voiceId,
      category: 'se',
      startTime: t,
      volume: vol,
      gainNode: gainImpact,
      nodes: nodesToDisconnect
    });

    oscRing.onended = () => {
      for (const n of nodesToDisconnect) {
        try { n.disconnect(); } catch (_) {}
      }
      this.releaseVoice(voiceId);
    };

    oscRing.start(t + 0.02);
    oscRing.stop(t + 0.23);
  }

  /**
   * 切り離し音（ブレーキ管空気緩解 プシュー音）
   */
  public playDecouplingSound(distanceFactor: number = 1.0) {
    if (this.isMuted || distanceFactor < 0.04) return;
    this.initContext();
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;

    const t = this.ctx.currentTime;
    const vol = 0.4 * Math.min(1.0, distanceFactor);
    if (vol < 0.005) return;

    const voiceId = this.acquireVoice('se', vol);
    if (voiceId === null) return;

    const nodesToDisconnect: AudioNode[] = [];

    // ホワイトノイズ＋バンドパス下降スウィープ（エアー排気）
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2200, t);
    filter.frequency.exponentialRampToValueAtTime(600, t + 0.35);
    filter.Q.setValueAtTime(1.5, t);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol * 0.6, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);

    noiseSource.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    nodesToDisconnect.push(noiseSource, filter, gain);

    noiseSource.start(t);
    noiseSource.stop(t + 0.4);

    // カチャッという密着解放レバー音
    const oscLever = this.ctx.createOscillator();
    const gainLever = this.ctx.createGain();
    oscLever.type = 'triangle';
    oscLever.frequency.setValueAtTime(450, t);
    oscLever.frequency.exponentialRampToValueAtTime(180, t + 0.05);

    gainLever.gain.setValueAtTime(vol * 0.35, t);
    gainLever.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

    oscLever.connect(gainLever);
    gainLever.connect(this.masterGain);
    nodesToDisconnect.push(oscLever, gainLever);

    this.registerVoice(voiceId, {
      id: voiceId,
      category: 'se',
      startTime: t,
      volume: vol,
      gainNode: gain,
      nodes: nodesToDisconnect
    });

    noiseSource.onended = () => {
      for (const n of nodesToDisconnect) {
        try { n.disconnect(); } catch (_) {}
      }
      this.releaseVoice(voiceId);
    };

    oscLever.start(t);
    oscLever.stop(t + 0.07);
  }

  /**
   * 前面展望（Cab View）開始時の車内モーター/走行音
   */
  public startCabMotorSound(initialSpeed: number = 0) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain || this.isCabActive) return;

    this.isCabActive = true;
    const t = this.ctx.currentTime;

    // 1. 車内VVVFインバータ音オシレーター
    this.cabMotorOsc = this.ctx.createOscillator();
    this.cabMotorGain = this.ctx.createGain();
    this.cabMotorOsc.type = 'sawtooth';

    const motorPitch = 240 + Math.min(1200, initialSpeed * 15);
    this.cabMotorOsc.frequency.setValueAtTime(motorPitch, t);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, t);

    this.cabMotorGain.gain.setValueAtTime(0.08, t);

    this.cabMotorOsc.connect(filter);
    filter.connect(this.cabMotorGain);
    this.cabMotorGain.connect(this.masterGain);
    this.cabMotorOsc.start(t);

    // 2. 台車フロアノイズ（車内ランブル音）
    if (this.noiseBuffer) {
      this.cabRumbleSource = this.ctx.createBufferSource();
      this.cabRumbleSource.buffer = this.noiseBuffer;
      this.cabRumbleSource.loop = true;

      const rumbleFilter = this.ctx.createBiquadFilter();
      rumbleFilter.type = 'lowpass';
      rumbleFilter.frequency.setValueAtTime(120, t);

      this.cabRumbleGain = this.ctx.createGain();
      this.cabRumbleGain.gain.setValueAtTime(0.12, t);

      this.cabRumbleSource.connect(rumbleFilter);
      rumbleFilter.connect(this.cabRumbleGain);
      this.cabRumbleGain.connect(this.masterGain);
      this.cabRumbleSource.start(t);
    }
  }

  /**
   * 前面展望時のモーター音ピッチ更新
   */
  public updateCabSpeed(speed: number) {
    if (!this.isCabActive || !this.ctx || this.isMuted) return;
    const t = this.ctx.currentTime;

    if (this.cabMotorOsc && this.cabMotorGain) {
      // 速度に連動したVVVF/主電動機回転音の周波数変化
      const targetFreq = 200 + Math.min(1400, speed * 22);
      this.cabMotorOsc.frequency.setTargetAtTime(targetFreq, t, 0.1);
      const motorVol = (speed > 1) ? 0.09 : 0.02;
      this.cabMotorGain.gain.setTargetAtTime(motorVol, t, 0.1);
    }

    if (this.cabRumbleGain) {
      const rumbleVol = (speed > 1) ? 0.14 : 0.03;
      this.cabRumbleGain.gain.setTargetAtTime(rumbleVol, t, 0.1);
    }
  }

  /**
   * 前面展望解除時の車内音停止
   */
  public stopCabMotorSound() {
    if (!this.isCabActive) return;
    this.isCabActive = false;

    if (this.cabMotorOsc) {
      try {
        this.cabMotorOsc.stop();
        this.cabMotorOsc.disconnect();
      } catch (_) {}
      this.cabMotorOsc = null;
      this.cabMotorGain = null;
    }

    if (this.cabRumbleSource) {
      try {
        this.cabRumbleSource.stop();
        this.cabRumbleSource.disconnect();
      } catch (_) {}
      this.cabRumbleSource = null;
      this.cabRumbleGain = null;
    }
  }

  /**
   * Train Horn (Electric Horn / 空笛)
   */
  public playHorn() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const t = this.ctx.currentTime;
    // Dual tone (standard Japanese electric train horn e.g. E231/205)
    const tones = [370, 440];

    tones.forEach(freq => {
      if (!this.ctx || !this.masterGain) return;
      const voiceId = this.acquireVoice('se', 0.2);
      if (voiceId === null) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.2, t + 0.05);
      gain.gain.setValueAtTime(0.2, t + 0.6);
      gain.gain.linearRampToValueAtTime(0.001, t + 0.9);

      osc.connect(gain);
      gain.connect(this.masterGain);

      const nodes: AudioNode[] = [osc, gain];
      this.registerVoice(voiceId, {
        id: voiceId,
        category: 'se',
        startTime: t,
        volume: 0.2,
        gainNode: gain,
        nodes
      });

      osc.onended = () => {
        for (const n of nodes) {
          try { n.disconnect(); } catch (_) {}
        }
        this.releaseVoice(voiceId);
      };

      osc.start(t);
      osc.stop(t + 0.95);
    });
  }

  /**
   * Station Departure Bell (Chime / 発車ベル)
   */
  public playStationBell() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const t = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 (classic chime)

    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const voiceId = this.acquireVoice('se', 0.25);
      if (voiceId === null) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + idx * 0.14);

      gain.gain.setValueAtTime(0.25, t + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.14 + 0.4);

      osc.connect(gain);
      gain.connect(this.masterGain);

      const nodes: AudioNode[] = [osc, gain];
      this.registerVoice(voiceId, {
        id: voiceId,
        category: 'se',
        startTime: t + idx * 0.14,
        volume: 0.25,
        gainNode: gain,
        nodes
      });

      osc.onended = () => {
        for (const n of nodes) {
          try { n.disconnect(); } catch (_) {}
        }
        this.releaseVoice(voiceId);
      };

      osc.start(t + idx * 0.14);
      osc.stop(t + idx * 0.14 + 0.45);
    });
  }

  /**
   * Construction Sound (Click / Clang)
   */
  public playBuildSound() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const voiceId = this.acquireVoice('se', 0.3);
    if (voiceId === null) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.08);

    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

    osc.connect(gain);
    gain.connect(this.masterGain);

    const nodes: AudioNode[] = [osc, gain];
    this.registerVoice(voiceId, {
      id: voiceId,
      category: 'se',
      startTime: t,
      volume: 0.3,
      gainNode: gain,
      nodes
    });

    osc.onended = () => {
      for (const n of nodes) {
        try { n.disconnect(); } catch (_) {}
      }
      this.releaseVoice(voiceId);
    };

    osc.start(t);
    osc.stop(t + 0.12);
  }

  /**
   * Demolish / Bulldozer Sound
   */
  public playDemolishSound() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const voiceId = this.acquireVoice('se', 0.35);
    if (voiceId === null) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);

    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    osc.connect(gain);
    gain.connect(this.masterGain);

    const nodes: AudioNode[] = [osc, gain];
    this.registerVoice(voiceId, {
      id: voiceId,
      category: 'se',
      startTime: t,
      volume: 0.35,
      gainNode: gain,
      nodes
    });

    osc.onended = () => {
      for (const n of nodes) {
        try { n.disconnect(); } catch (_) {}
      }
      this.releaseVoice(voiceId);
    };

    osc.start(t);
    osc.stop(t + 0.2);
  }

  /**
   * UI Select / Toggle Sound
   */
  public playSelectSound() {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const voiceId = this.acquireVoice('se', 0.2);
    if (voiceId === null) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1760, t + 0.05);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

    osc.connect(gain);
    gain.connect(this.masterGain);

    const nodes: AudioNode[] = [osc, gain];
    this.registerVoice(voiceId, {
      id: voiceId,
      category: 'se',
      startTime: t,
      volume: 0.2,
      gainNode: gain,
      nodes
    });

    osc.onended = () => {
      for (const n of nodes) {
        try { n.disconnect(); } catch (_) {}
      }
      this.releaseVoice(voiceId);
    };

    osc.start(t);
    osc.stop(t + 0.07);
  }
}
