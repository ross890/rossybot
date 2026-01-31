// ===========================================
// MODULE 3: SCORING & RANKING SYSTEM
// ===========================================

import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { kolWalletMonitor } from './kol-tracker.js';
import {
    TokenMetrics,
    SocialMetrics,
    VolumeAuthenticityScore,
    ScamFilterOutput,
    KolWalletActivity,
    ScoreFactors,
    TokenScore,
    RiskLevel,
    ScamFilterResult,
    WalletType,
} from '../types/index.js';

// ============ SCORING WEIGHTS ============

const FACTOR_WEIGHTS = {
    onChainHealth: 0.20,
    socialMomentum: 0.15,
    kolConvictionMain: 0.25,
    kolConvictionSide: 0.15,
    scamRiskInverse: 0.25,
} as const;

// ============ SCORING THRESHOLDS ============

const THRESHOLDS = {
    MIN_SCORE_BUY: appConfig.trading.minScoreBuySignal,
    MIN_SCORE_WATCH: appConfig.trading.minScoreWatchSignal,
    RISK_VERY_LOW_MAX_SCORE: 85,
    RISK_LOW_MAX_SCORE: 75,
    RISK_MEDIUM_MAX_SCORE: 65,
    RISK_HIGH_MAX_SCORE: 55,
    IDEAL_VOLUME_MCAP_RATIO: 0.3,
    IDEAL_HOLDER_COUNT: 500,
    IDEAL_TOP10_CONCENTRATION: 30,
    IDEAL_MENTION_VELOCITY: 100,
    NARRATIVE_STRONG_MULTIPLIER: 1.3,
    NARRATIVE_MODERATE_MULTIPLIER: 1.15,
    NARRATIVE_WEAK_MULTIPLIER: 1.0,
} as const;

const CURRENT_META_THEMES = [
    'AI', 'agent', 'political', 'trump', 'maga', 'pepe', 'doge', 'cat', 'dog', 'meme revival', 'solana native',
  ] as const;

// ============ SCORING ENGINE ============

export class ScoringEngine {
    calculateScore(
          tokenAddress: string,
          metrics: TokenMetrics,
          socialMetrics: SocialMetrics,
          volumeAuthenticity: VolumeAuthenticityScore,
          scamFilter: ScamFi/l/t e=r=O=u=t=p=u=t=,=
  = = = = =k=o=l=A=c=t=i=v=i=t=i=e=s=:= =K=o=l=W=a=l=l=e=t=A=c=t=i=v=i
t/y/[ ]M
O D U)L:E  T3o:k eSnCSOcRoIrNeG  {&
    R A N KcIoNnGs tS YfSaTcEtMo
r/s/:  =S=c=o=r=e=F=a=c=t=o=r=s= === ={=
  = = = = = = =o=n=C=h=a=i=n=H=e=a=l=t=h=:= =t=h=i=s=.
  c
  ailmcpuolratt e{O naCphpaCionnHfeiagl t}h (fmreotmr i'c.s.,/ cvoonlfuimge/Aiuntdheexn.tjisc'i;t
                                             yi)m,p
o r t   {   lsoogcgiearl M}o mfernotmu m':. .t/huitsi.lcsa/llcouglgaetre.Sjosc'i;a
liMmopmoerntt u{m (ksoolcWiaalllMeettMroincist)o,r
               }   f r o mk o'l.C/oknovli-cttriaocnkMeari.nj:s 't;h
iism.pcoarltc u{l
a t eTKookleCnoMnevtircitciso,n
                ( k oSloAccitailvMiettireisc,s ,W
                 a l lVeotlTuympeeA.uMtAhIeNn)t,i
                c i t y S c okroel,C
                o n vSiccatmiFoinlStiedreO:u ttphuits,.
                  c a lKcoullWaatlelKeotlACcotnivviicttyi,o
                n ( kSocloArcetFiavcittoiress,,
                     W aTlolkeetnTSycpoer.eS,I
                   D E )R,i
                s k L e v e ls,c
                a m RSicsakmIFnivletresreR:e stuhlits,.
                  c a lWcaulllaetteTSycpaem,R
                i}s kfIrnovme r's.e.(/stcyapmeFsi/litnedre)x,.
  j s ' ; 

 /n/a r=r=a=t=i=v=e=B=o=n=u=s=:  StChOiRsI.NcGa lWcEuIlGaHtTeSN a=r=r=a=t=i=v=e=B=o=n=u=s
(
  mceotnrsitc sF,A CsToOcRi_aWlEMIeGtHrTiSc s=) ,{

       o n C htaiimniHnegaBlotnhu:s :0 .t2h0i,s
  . c asloccuilaaltMeoTmiemnitnugmB:o n0u.s1(5m,e
t r ikcosl)C,o
n v i c t}i;o
n
M a i n :c o0n.s2t5 ,b
a s ekSocloCroen v=i c(tfiaocntSoirdse.:o n0C.h1a5i,n
                       H e aslctahm R*i sFkAICnTvOeRr_sWeE:I G0H.T2S5.,o
n}C haasi ncHoenasltt;h
)
 /+/
  = = = = = =(=f=a=c=t=o=r sS.CsOoRcIiNaGl MToHmReEnStHuOmL D*S  F=A=C=T=O=R=_=W=E=I=G=H=T
              S
              .csooncsita lTMHoRmEeSnHtOuLmD)S  +=
  { 
         M I(Nf_aScCtOoRrEs_.BkUoYl:C oanpvpiCcotnifoingM.atirna d*i nFgA.CmTiOnRS_cWoErIeGBHuTySS.ikgonlaClo,n
v i cMtIiNo_nSMCaOiRnE)_ W+A
T C H :   a p(pfCaocntfoirgs..tkroaldCionngv.imcitniSocnoSriedWea t*c hFSAiCgTnOaRl_,W
E I GRHITSSK._kVoElRCYo_nLvOiWc_tMiAoXn_SSiCdOeR)E :+ 
  8 5 , 
       R(IfSaKc_tLoOrWs_.MsAcXa_mSRCiOsRkEI:n v7e5r,s
e   *R IFSAKC_TMOERD_IWUEMI_GMHATXS_.SsCcOaRmER:i s6k5I,n
v e rRsIeS)K;_
H
I G H _ McAoXn_sStC OcRoEm:p o5s5i,t
e S cIoDrEeA L=_ VMOaLtUhM.Em_iMnC(A1P5_0R,A TbIaOs:e S0c.o3r,e
  +  IfDaEcAtLo_rHsO.LnDaErRr_aCtOiUvNeTB:o n5u0s0 ,+
    f aIcDtEoArLs_.TtOiPm1i0n_gCBOoNnCuEsN)T;R
A T I O Nc:o n3s0t, 
{   cIoDnEfAiLd_eMnEcNeT,I OcNo_nVfEiLdOeCnIcTeYB:a n1d0,0 ,f
l a gNsA R}R A=T ItVhEi_sS.TdReOtNeGr_mMiUnLeTCIoPnLfIiEdRe:n c1e.(3m,e
t r iNcAsR,R AkToIlVAEc_tMiOvDiEtRiAeTsE,_ MsUcLaTmIFPiLlItEeRr:) ;1
. 1 5 , 
  c o nNsAtR RrAiTsIkVLEe_vWeElA K=_ MtUhLiTsI.PdLeItEeRr:m i1n.e0R,i
s}k Laesv eclo(ncsotm;p
o
sciotnesStc oCrUeR,R EsNcTa_mMFEiTlAt_eTrH,E MkEoSl A=c t[i
  v i t'iAeIs'),; 
'
  a g e n tr'e,t u'rpno l{i ttiockaeln'A,d d'rtersusm,p 'c,o m'pmoasgiat'e,S c'opreep:e 'M,a t'hd.orgoeu'n,d ('ccoamtp'o,s i'tdeoSgc'o,r e')m,e mfea crteovrisv,a lc'o,n f'isdoelnacnea,  ncaotnifvied'e,n
  c]e Baasn dc,o nfslta;g
                          s
                          ,/ /r i=s=k=L=e=v=e=l= =}=;=
=   S}C
O
R I NpGr iEvNaGtIeN Ec a=l=c=u=l=a=t=e=O=n=C=h=a
i
neHxepaolrtth (cmleatsrsi cSsc:o rTionkgeEnnMgeitnrei c{s
,   vcoallucmuelAauttehSecnotriec(i
                                  t y :   VtoolkuemneAAdudtrheesnst:i csittryiSncgo,r
                                                        e ) :   nmuemtbreirc s{:
                                                          T o k elneMte tsrciocrse, 
                                                          =   0 ; 
s o c i aslcMoerter i+c=s :M aStohc.imailnM(e2t5r,i c(sm,e
                                                      t r i c sv.ovloulmuemAeuMtahreknettiCcaiptRya:t iVoo l/u mTeHARuEtShHeOnLtDiSc.iItDyESAcLo_rVeO,L
                                                        U M E _ MsCcAaPm_FRiAlTtIeOr):  *S c2a5m)F;i
                                                        l t e r Osuctopruet ,+
                                                          =   M a tkho.lmAicnt(i2v5i,t i(emse:t rKioclsW.ahlolledteArcCtoiuvnitt y/[ ]T
                                                                                         H R E)S:H OTLoDkSe.nISDcEoArLe_ H{O
                                                                                                                           L D E R _cCoOnUsNtT )f a*c t2o5r)s;:
                                                          S c o rsecFoarcet o+r=s  M=a t{h
                                                                                         . m a x ( 0 ,o n2C5h a-i n(H(emaelttrhi:c st.htiosp.1c0aClocnucleantterOantCihoani n-H eTaHlRtEhS(HmOeLtDrSi.cIsD,E AvLo_lTuOmPe1A0u_tChOeNnCtEiNcTiRtAyT)I,O
                                                                                                                      N )   /   2 )s)o;c
                                                                                         i a l M osmceonrteu m+:=  tvhoilsu.mceaAluctuhleantteiScoictiya.lsMcoomreen t*u m0(.s2o5c;i
                                                                                         a l M e trreitcusr)n, 
                                                                                           M a t h . m ikno(l1C0o0n,v iMcattiho.nmMaaxi(n0:,  tshciosr.ec)a)l;c
                                                                                         u l a}t
                                                                                                                           e
                                                                                                                           K o lpCroinvvaitcet icoanl(ckuollaAtcetSiovciitaileMso,m eWnatlulme(tsToycpiea.lMMAeItNr)i,c
                                                                                                                                                      s :   S o c ikaollMCeotnrviiccst)i:o nnSuimdbee:r  t{h
                                                                                                                                                                                                           i s . c allectu lsactoerKeo l=C o0n;v
                                                                                                                                                                                                           i c t i osnc(okroel A+c=t iMvaitthi.emsi,n (W3a0l,l e(tsToycpiea.lSMIeDtEr)i,c
                                                                                                                                                                                                                                                       s . m e n t isocnaVmeRliosckiItnyv1ehr s/e :T HtRhEiSsH.OcLaDlSc.uIlDaEtAeLS_cMaEmNRTiIsOkNI_nVvEeLrOsCeI(TsYc)a m*F i3l0t)e;r
                                                                                                                                                                                                           ) , 
                                                                                                                               s c o r en a+r=r astoicvieaBloMneutsr:i ctsh.iesn.gcaaglecmuelnattQeuNaalrirtayt i*v e2B5o;n
                                                                                                                                                                                                           u s ( m estcroirces ,+ =s oscoicailaMleMtertircisc)s,.
                                                                                                                                                                                                             a c c o u n ttAiumtihnegnBtoincuist:y  t*h i2s5.;c
                                                                                                                                                                                                           a l c u lsactoerTei m+i=n g(B(osnoucsi(amleMtertircisc)s,.
                                                                                                                                                                                                                                       s e n t i}m;e
                                                                                                                           n
                                                                                                                           t P o l acrointsyt  +b a1s)e S/c o2r)e  *=  2(0f;a
                                                                                                                           c t o r sr.eotnuCrhna iMnaHteha.lmtihn (*1 0F0A,C TMOaRt_hW.EmIaGxH(T0S,. osncCohraei)n)H;e
                                                                                                                           a l t}h
                                                        )
  + 
    p r i v a t e( fcaacltcourlsa.tseoKcoilaCloMnovmiecnttiuomn (*a cFtAiCvTiOtRi_eWsE:I GKHoTlSW.aslolceitaAlcMtoimveinttyu[m]),  +w
                                                        a l l e t T y(pfea:c tWoarlsl.ektoTlyCpoen)v:i cntuimobneMra i{n
                                                                                                                         *   F AcCoTnOsRt_ WfEiIlGtHeTrSe.dk o=l CaocntviivcittiioensM.afiinl)t e+r
                                                                                                                       ( a   = >   a(.fwaacltloerts..wkaolllCeotnTvyipcet i=o=n=S iwdael l*e tFTAyCpTeO)R;_
                                                                                                                       W E I G HiTfS .(kfoillCtoenrveidc.tlieonngStihd e=)= =+ 
                                                                                                                         0 )   r e t u(rfna c0t;o
                                                                                                                       r s . s claemtR itsoktIanlvWeerisgeh t*  =F A0C;T
                                                                                                                       O R _ W EfIoGrH T(Sc.osncsatm RaicstkiIvnivteyr soef) ;f
                                                                                                                       i
                                                                                                                       l t e r ecdo)n s{t
                                                                                                                                          c o m p o sciotnesStc owreei g=h tM a=t hk.omliWna(l1l5e0t,M obnaisteoSrc.ocrael c+u lfaatcetSoirgsn.anlaWreriagthitv(eaBcotniuvsi t+y )f;a
                                                                                                                                        c t o r s . tciomnisntg BsoinzuesM)u;l
                                                                                                                                        t i p l iceorn s=t  M{a tcho.nmfiind(e2n,c ea,c tciovniftiyd.etnrcaenBsaancdt,i ofnl.asgosl A}m o=u ntth i/s .1d0e)t;e
                                                                                                                                        r m i n e C otnoftiadleWnecieg(hmte t+r=i cwse,i gkhotl A*c tsiivzietMiuelst,i pslciaemrF;i
                                                                                                                                        l t e r )};
                                                                                                                       
                                                                rceotnusrtn  rMiastkhL.emvienl( 1=0 0t,h itso.tdaeltWeerimgihnte R*i s5k0L)e;v
                                                                                                                       e l (}c
                                                        o
                                                        m p opsriitveaStceo rcea,l csuclaamtFeiSlctaemrR,i skkoIlnAvcetrisvei(tsiceasm)F;i
                                                        l
                                                        t e r :  rSectaumrFni l{t etroOkuetnpAudtd)r:e snsu,m bceorm p{o
                                                                                                                       s i t e Sicfo r(es:c aMmaFtihl.treoru.nrde(scuolmtp o=s=i=t eSSccaomrFei)l,t efraRcetsourlst,. RcEoJnEfCiTd)e nrceet,u rcno n0f;i
                                                                                                                       d e n c elBeatn ds,c ofrlea g=s ,1 0r0i;s
                                                                                                                       k L e v eslc o}r;e
                                                                                  - =} 
s
                                                        c a mpFriilvtaetre. fclaalgcsu.llaetnegOtnhC h*a i1n0H;e
                                                        a l t h (imfe t(r!isccsa:m FTiolkteenrM.ectornitcrsa,c tvAonlaulmyesAiust.hmeinnttiAcuitthyo:r iVtoylRuemveoAkuetdh)e nstciocriet y-S=c o3r0e;)
:   n u mibfe r( !{s
                   c a m F illette rs.ccoornet r=a c0t;A
                                                        n a l y ssicso.rfer e+e=z eMAautthh.omriint(y2R5e,v o(kmeedt)r isccso.rveo l-u=m e3M0a;r
                                                        k e t C aipfR a(tsicoa m/F iTlHtReErS.HbOuLnDdSl.eIADnEaAlLy_sViOsL.UhMaEs_RMuCgAHPi_sRtAoTrIyO))  s*c o2r5e) ;-
                                                          =   2 5 ;s
                                                        c o r e  i+f=  (Msactahm.Fmiilnt(e2r5.,b u(nmdelterAincasl.yhsoilsd.ebruCnodulnetd S/u pTpHlRyEPSeHrOcLeDnSt. I>D E1A5L)_ HsOcLoDrEeR _-C=O U1N5T;)
                                                                          *   2 5i)f; 
( s c a msFciolrtee r+.=d eMvaBtehh.amvaixo(u0r,? .2t5r a-n s(f(emrerterdiTcosC.etxo)p 1s0cCoornec e-n=t r4a0t;i
                                                        o n   -  iTfH R(EsScHaOmLFDiSl.tIeDrE.ArLe_sTuOlPt1 0=_=C=O NSCcEaNmTRATION) / 2));
                                                            score += volumeAuthenticity.score * 0.25;
                                                            return Math.min(100, Math.max(0, score));
                                                       }

  private calculateSocialMomentum(socialMetrics: SocialMetrics): number {
    let score = 0;
        score += Math.min(30, (socialMetrics.mentionVelocity1h / THRESHOLDS.IDEAL_MENTION_VELOCITY) * 30);
        score += socialMetrics.engagementQuality * 25;
        score += socialMetrics.accountAuthenticity * 25;
        score += ((socialMetrics.sentimentPolarity + 1) / 2) * 20;
        return Math.min(100, Math.max(0, score));
  }

  private calculateKolConviction(activities: KolWalletActivity[], walletType: WalletType): number {
    const filtered = activities.filter(a => a.wallet.walletType === walletType);
        if (filtered.length === 0) return 0;
        let totalWeight = 0;
        for (const activity of filtered) {
                const weight = kolWalletMonitor.calculateSignalWeight(activity);
                const sizeMultiplier = Math.min(2, activity.transaction.solAmount / 10);
                totalWeight += weight * sizeMultiplier;
        }
        return Math.min(100, totalWeight * 50);
  }

  private calculateScamRiskInverse(scamFilter: ScamFilterOutput): number {
    if (scamFilter.result === ScamFilterResult.REJECT) return 0;
        let score = 100;
        score -= scamFilter.flags.length * 10;
        if (!scamFilter.contractAnalysis.mintAuthorityRevoked) score -= 30;
        if (!scamFilter.contractAnalysis.freezeAuthorityRevoked) score -= 30;
        if (scamFilter.bundleAnalysis.hasRugHistory) score -= 25;
        if (scamFilter.bundleAnalysis.bundledSupplyPercent > 15) score -= 15;
        if (scamFilter.devBehaviour?.transferredToCex) score -= 40;
        if (scamFilter.result === ScamFilterResult.FLAG) score = Math.min(score, 70);
        return Math.max(0, score);
  }

  private calculateNarrativeBonus(metrics: TokenMetrics, socialMetrics: SocialMetrics): number {
    if (!socialMetrics.narrativeFit) return 0;
        const narrative = socialMetrics.narrativeFit.toLowerCase();
        const isStrongMatch = CURRENT_META_THEMES.some(theme =>
                narrative.includes(theme.toLowerCase()) ||
                metrics.name.toLowerCase().includes(theme.toLowerCase()) ||
                metrics.ticker.toLowerCase().includes(theme.toLowerCase())
                                                           );
        if (isStrongMatch) return 25;
        if (socialMetrics.kolMentions.length > 0) return 15;
        return 5;
  }

  private calculateTimingBonus(metrics: TokenMetrics): number {
    const ageMinutes = metrics.tokenAge;
        if (ageMinutes < 60) return 20;
        if (ageMinutes < 180) return 15;
        if (ageMinutes < 360) return 10;
        if (ageMinutes < 720) return 5;
        return 0;
  }

  private determineConfidence(
        metrics: TokenMetrics,
        kolActivities: KolWalletActivity[],
        scamFilter: ScamFilterOutput
  ): { confidence: 'HIGH' | 'MEDIUM' | 'LOW'; confidenceBand: number; flags: string[] } {
        const flags: string[] = [];
        let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
        let confidenceBand = 5;

    if (metrics.tokenAge < 120) { flags.push('NEW_TOKEN'); confidence = 'MEDIUM'; confidenceBand = 15; }
        if (metrics.liquidityPool < 25000) { flags.push('LOW_LIQUIDITY'); if (confidence === 'HIGH') confidence = 'MEDIUM'; confidenceBand = Math.max(confidenceBand, 10); }

    const mainWalletActivities = kolActivities.filter(a => a.wallet.walletType === WalletType.MAIN);
        const sideWalletActivities = kolActivities.filter(a => a.wallet.walletType === WalletType.SIDE);
        if (kolActivities.length === 1) flags.push('SINGLE_KOL');
        if (mainWalletActivities.length === 0 && sideWalletActivities.length > 0) { flags.push('SIDE_ONLY'); if (confidence === 'HIGH') confidence = '
