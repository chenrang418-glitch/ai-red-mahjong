import type { CharacterDefinition } from './types'
import { ZHANGLU } from './sp-zhanglu'
import { LIUBIAN } from './sp-liubian'
import { MIHENG } from './sp-miheng'
import { ZHANGQIYING } from './sp-zhangqiying'
import { CHENGGONGYING } from './sp-chenggongying'
import { HANFU } from './sp-hanfu'
import { XINXIANYING } from './sp-xinxianying'
import { CHENDENG } from './sp-chendeng'
import { YANPU } from './sp-yanpu'
import { WANGRONG } from './sp-wangrong'
import { SUNHAO } from './sp-sunhao'
import { WUJING } from './sp-wujing'
import { QIANZHAO } from './sp-qianzhao'
import { BAOXIN } from './sp-baoxin'
import { YANGFU } from './sp-yangfu'
import { YUANHUAN } from './sp-yuanhuan'
import { DUXI } from './sp-duxi'
import { JIANGWAN } from './sp-jiangwan'
import { ZHUJUN } from './sp-zhujun'
import { TAOQIAN } from './sp-taoqian'
import { YUANSHU } from './sp-yuanshu'
import { YANGXIU } from './sp-yangxiu'
import { CHENLIN } from './sp-chenlin'
import { ZHANGXINGCAI } from './sp-zhangxingcai'
import { GUANYINPING } from './sp-guanyinping'
import { CAOANG } from './sp-caoang'
import { HETAIHOU } from './sp-hetaihou'
import { LIUXIE } from './sp-liuxie'
import { MAYUNLU } from './sp-mayunlu'
import { MIZHU } from './sp-mizhu'
import { CAOCHUN } from './sp-caochun'
import { XIZHICAI } from './sp-xizhicai'
import { HAOZHAO } from './sp-haozhao'
import { WANGJI } from './sp-wangji'
import { DONGYUN } from './sp-dongyun'
import { QINMI } from './sp-qinmi'
import { YIJI } from './sp-yiji'
import { TIANCHOU } from './sp-tianchou'
import { TIANYU } from './sp-tianyu'
import { LUJI } from './sp-luji'
import { CHENGYU } from './sp-chengyu'
import { CAOSHUANG } from './sp-caoshuang'
import { ZHANGCHANGPU } from './sp-zhangchangpu'
import { LVQIAN } from './sp-lvqian'
import { JIANGGAN } from './sp-jianggan'
import { ZHUGE_DAN } from './sp-zhugedan'
import { XUJING } from './sp-xujing'
import { GAOLAN } from './sp-gaolan'
import { LIJUE } from './sp-lijue'
import { GUOSI } from './sp-guosi'
import { PANFENG } from './sp-panfeng'
import { SHIXIE } from './sp-shixie'
import { ZHUGEJIN } from './sp-zhugejin'
import { DONGBAI } from './sp-dongbai'
import { ZHUGEKE } from './sp-zhugeke'
import { ZHUGEZHAN } from './sp-zhugezhan'
import { ZHANGXIU } from './sp-zhangxiu'
import { TADUN } from './sp-tadun'
import { SUNQIAN } from './sp-sunqian'
import { SHAMOKE } from './sp-shamoke'
import { WANGPING } from './sp-wangping'
import { ZUMAO } from './sp-zumao'
import { XUSHI } from './sp-xushi'
import { YANJUN } from './sp-yanjun'
import { FEIYI } from './sp-feiyi'
import { PANJUN } from './sp-panjun'
import { ZHOUFANG } from './sp-zhoufang'
import { HUANGZU } from './sp-huangzu'
import { LINGCAO } from './sp-lingcao'
import { YUANTAN_YUANSHANG } from './sp-yuantanyuanshang'
import { LUKANG } from './sp-lukang'
import { XURONG } from './sp-xurong'
import { FANCHOU } from './sp-fanchou'
import { BEIMIHU } from './sp-beimihu'
import { QUYI } from './sp-quyi'
import { CHUNYUQIONG } from './sp-chunyuqiong'
import { LIUQI } from './sp-liuqi'
import { SIMAHUI } from './sp-simahui'
import { LUKAI } from './sp-lukai'
import { CAOXING } from './sp-caoxing'
import { GUANSUO } from './sp-guansuo'
import { ZHAOXIANG } from './sp-zhaoxiang'
import { BAOSANNIANG } from './sp-baosanniang'
import { HUAMAN } from './sp-huaman'
import { ZHUGEGUO } from './sp-zhugeguo'
import { LIYAN } from './sp-liyan'
import { MENGDA } from './sp-mengda'
import { PENGYANG } from './sp-pengyang'
import { XUYOU } from './sp-xuyou'
import { YANYAN } from './sp-yanyan'
import { GONGSUNZAN } from './sp-gongsunzan'
import { ZHANGBAO } from './sp-zhangbao'
import { ZHANGJI } from './sp-zhangji'
import { GUANHAI } from './sp-guanhai'
import { SUNSHAO } from './sp-sunshao'
import { WUANGUO } from './sp-wuanguo'
import { MAXIU_MATIE } from './sp-maxiumatie'
import { LUZHI } from './sp-luzhi'
import { HUAXIN } from './sp-huaxin'
import { MARIDI } from './sp-maridi'
import { WANGLANG } from './sp-wanglang'
import { GUOHUANGHOU } from './sp-guohuanghou'
import { KONGSHU } from './sp-kongshu'
import { ZHAOZHONG } from './sp-zhaozhong'
import { CAIMAO } from './sp-caimao'
import { DONGHE } from './sp-donghe'
import { CHENGJI_CHENGCUI } from './sp-chengjichengcui'
import { ZHULING } from './sp-zhuling'
import { YANROU } from './sp-yanrou'
import { CAOXI } from './sp-caoxi'
import { WEIZI } from './sp-weizi'
import { LIANGXING } from './sp-liangxing'
import { LIUPI } from './sp-liupi'
import { CAOTENG } from './sp-caoteng'
import { GUOTU } from './sp-guotu'
import { KEBINENG } from './sp-kebineng'
import { NIUFU } from './sp-niufu'
import { YUANJI } from './sp-yuanji'
import { LIUYAN } from './sp-liuyan'
import { DINGYUAN } from './sp-dingyuan'
import { HEJIN } from './sp-hejin'
import { LVLINGQI } from './sp-lvlingqi'
import { WENPIN } from './sp-wenpin'
import { LUYUSHENG } from './sp-luyusheng'
import { XIAHOUHUI } from './sp-xiahouhui'
import { WENQIN } from './sp-wenqin'
import { ZHANGMANCHENG } from './sp-zhangmancheng'
import { LUSHI } from './sp-lushi'
import { XIAHOUXUAN } from './sp-xiahouxuan'
import { QINLANG } from './sp-qinlang'
import { HEQI } from './sp-heqi'
import { CHENWU_DONGXI } from './sp-chenwu-dongxi'
import { LVFAN } from './sp-lvfan'
import { LIUBA } from './sp-liuba'
import { DENGZHI } from './sp-dengzhi'
import { SUNDENG } from './sp-sundeng'
import { SUNRU } from './sp-sunru'
import { CHENGBING } from './sp-chengbing'
import { RUANJI } from './sp-ruanji'
import { ZHOUFEI } from './sp-zhoufei'
import { LIUYU } from './sp-liuyu'
import { HUANGHAO } from './sp-huanghao'
import { CENHUN } from './sp-cenhun'
import { ZHANGRANG } from './sp-zhangrang'
import { WUXIAN } from './sp-wuxian'
import { XUEZONG } from './sp-xuezong'
import { CAIYONG } from './sp-caiyong'
import { LUZHI_SP } from './sp-luzhi_sp'
import { CHENDAO } from './sp-chendao'
import { ZHANGLIANG } from './sp-zhangliang'

/**
 * SP：项目此前未出现过的独立历史人物，采用三国杀 OL 经典/成熟身份技能版本。
 * 不含界限突破、国战、谋/势/星、SP 同人物重复版本、十周年重做、旧版淘汰技能。
 *
 * 第一批 10 / 10：袁术、杨修、陈琳、张星彩、关银屏、曹昂、何太后、刘协、
 * 马云騄、糜竺。
 * 第二批 10 / 10：曹纯、戏志才、郝昭、王基、董允、秦宓、伊籍、田畴、田豫、陆绩。
 * 第三批 10 / 10：程昱、曹爽、张昌蒲、吕虔、蒋干、诸葛诞、许靖、高览、李傕、郭汜。
 * 第四批 10 / 10：潘凤、士燮、诸葛瑾、董白、诸葛恪、诸葛瞻、张绣、蹋顿、孙乾、沙摩柯。
 * 第五批 10 / 10：王平、祖茂、徐氏、严畯、费祎、潘濬、周鲂、黄祖、凌操、袁谭袁尚。
 * 第六批 10 / 10：陆抗、徐荣、樊稠、卑弥呼、麹义、淳于琼、刘琦、司马徽、陆凯、曹性。
 * 第七批 10 / 10：孙皓、吴景、牵招、鲍信、杨阜、袁涣、杜袭、蒋琬、朱儁、陶谦。
 * 第八批 10 / 10：张鲁、刘辩、祢衡、张琪瑛、成公英、韩馥、辛宪英、陈登、阎圃、王荣。
 * 第九批 10 / 10：关索、赵襄、鲍三娘、花鬘、诸葛果、李严、孟达、彭羕、许攸、严颜。
 * 第十批 10 / 10：公孙瓒、张宝、张济、管亥、孙邵、武安国、马休马铁、卢植、华歆、马日磾。
 * 第十一批 10 / 10：王朗、郭皇后、孔淑、赵忠、蔡瑁、董翓、成济成倅、朱灵、阎柔、曹羲。
 * 第十二批 10 / 10：卫兹、梁兴、刘辟、曹腾、郭图、轲比能、牛辅、袁姬、刘焉、丁原。
 * 第十三批 10 / 10：何进、吕玲绮、文聘、陆郁生、夏侯徽、文钦、张曼成、卢氏、夏侯玄、秦朗。
 * 第十四批 10 / 10：贺齐、陈武董袭、吕范、刘巴、邓芝、孙登、孙茹、程秉、阮籍、周妃。
 * 第十五批 10 / 10：刘虞、黄皓、岑昏、张让、吴苋、薛综、蔡邕、鲁芝、陈到、张梁。
 */
export const SP_CHARACTERS: readonly CharacterDefinition[] = [
  YUANSHU,
  YANGXIU,
  CHENLIN,
  ZHANGXINGCAI,
  GUANYINPING,
  CAOANG,
  HETAIHOU,
  LIUXIE,
  MAYUNLU,
  MIZHU,
  CAOCHUN,
  XIZHICAI,
  HAOZHAO,
  WANGJI,
  DONGYUN,
  QINMI,
  YIJI,
  TIANCHOU,
  TIANYU,
  LUJI,
  CHENGYU,
  CAOSHUANG,
  ZHANGCHANGPU,
  LVQIAN,
  JIANGGAN,
  ZHUGE_DAN,
  XUJING,
  GAOLAN,
  LIJUE,
  GUOSI,
  PANFENG,
  SHIXIE,
  ZHUGEJIN,
  DONGBAI,
  ZHUGEKE,
  ZHUGEZHAN,
  ZHANGXIU,
  TADUN,
  SUNQIAN,
  SHAMOKE,
  WANGPING,
  ZUMAO,
  XUSHI,
  YANJUN,
  FEIYI,
  PANJUN,
  ZHOUFANG,
  HUANGZU,
  LINGCAO,
  YUANTAN_YUANSHANG,
  LUKANG,
  XURONG,
  FANCHOU,
  BEIMIHU,
  QUYI,
  CHUNYUQIONG,
  LIUQI,
  SIMAHUI,
  LUKAI,
  CAOXING,
  SUNHAO,
  WUJING,
  QIANZHAO,
  BAOXIN,
  YANGFU,
  YUANHUAN,
  DUXI,
  JIANGWAN,
  ZHUJUN,
  TAOQIAN,
  ZHANGLU,
  LIUBIAN,
  MIHENG,
  ZHANGQIYING,
  CHENGGONGYING,
  HANFU,
  XINXIANYING,
  CHENDENG,
  YANPU,
  WANGRONG,
  GUANSUO,
  ZHAOXIANG,
  BAOSANNIANG,
  HUAMAN,
  ZHUGEGUO,
  LIYAN,
  MENGDA,
  PENGYANG,
  XUYOU,
  YANYAN,
  GONGSUNZAN,
  ZHANGBAO,
  ZHANGJI,
  GUANHAI,
  SUNSHAO,
  WUANGUO,
  MAXIU_MATIE,
  LUZHI,
  HUAXIN,
  MARIDI,
  WANGLANG,
  GUOHUANGHOU,
  KONGSHU,
  ZHAOZHONG,
  CAIMAO,
  DONGHE,
  CHENGJI_CHENGCUI,
  ZHULING,
  YANROU,
  CAOXI,
  WEIZI,
  LIANGXING,
  LIUPI,
  CAOTENG,
  GUOTU,
  KEBINENG,
  NIUFU,
  YUANJI,
  LIUYAN,
  DINGYUAN,
  HEJIN,
  LVLINGQI,
  WENPIN,
  LUYUSHENG,
  XIAHOUHUI,
  WENQIN,
  ZHANGMANCHENG,
  LUSHI,
  XIAHOUXUAN,
  QINLANG,
  HEQI,
  CHENWU_DONGXI,
  LVFAN,
  LIUBA,
  DENGZHI,
  SUNDENG,
  SUNRU,
  CHENGBING,
  RUANJI,
  ZHOUFEI,
  LIUYU,
  HUANGHAO,
  CENHUN,
  ZHANGRANG,
  WUXIAN,
  XUEZONG,
  CAIYONG,
  LUZHI_SP,
  CHENDAO,
  ZHANGLIANG,
] as const
