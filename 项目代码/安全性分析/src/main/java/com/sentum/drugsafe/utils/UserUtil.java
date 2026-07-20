package com.sentum.drugsafe.utils;

import com.alibaba.fastjson.JSON;
import com.sentum.drugsafe.constant.Constants;
import com.sentum.drugsafe.pojo.SysUser;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import javax.servlet.http.HttpServletRequest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Component
@Slf4j
public class UserUtil {
    @Autowired
    RedisTemplate redisTemplate;

    public SysUser getCurrentUser() {
        HttpServletRequest request=((ServletRequestAttributes) RequestContextHolder.getRequestAttributes()).getRequest();
        String token = request.getHeader("token");
        return getUserByToken(token);
    }


    public SysUser getUserByToken(String token) {
        SysUser sysUser = null;
        try {
           Object obj= redisTemplate.opsForValue().get(Constants.ACCESS_TOKEN + token);
           if(obj!=null){
               sysUser=JSON.parseObject(obj.toString(), SysUser.class);
           }
        } catch (Exception e) {
            throw new RuntimeException("token无效");
        }

        if (sysUser == null) {
            throw new RuntimeException("token无效");
        }
        return sysUser;
    }


    public SysUser getUserById(Long userId){
        Object obj = this.redisTemplate.opsForValue().get(Constants.USER_PREFIX + userId);
        if (obj != null) {
            return (SysUser) obj;
        }
        throw new RuntimeException("用户未找到："+userId);
    }





        public static void main(String[] args) {
            String input = "常见不良反应\n" +
                    "临床试验中的不良反应\n" +
                    "1、类风湿性关节炎\n" +
                    "（1）发生率1%\n" +
                    "全身反应:发热（1.2%）\n" +
                    "免疫系统:感染、机会性感染（不包括肺结核）\n" +
                    "呼吸系统:上呼吸道感染（URTI）（急性鼻窦炎、喉炎、鼻咽炎、口咽痛、咽炎、咽扁桃体炎、鼻炎、鼻窦炎、扁桃体炎、病毒性上呼吸道感染）（13.5%）、咳嗽（2.2%）\n" +
                    "消化系统:恶心（3.5%）\n" +
                    "（2）发生率<1%\n" +
                    "免疫系统:带状疱疹、单纯疱疹（包括口腔疱疹）、口腔念珠菌病、结核病\n" +
                    "呼吸系统:肺炎\n" +
                    "血液淋巴系统:血栓形成\n" +
                    "2、银屑病关节炎\n" +
                    "免疫系统:带状疱疹（1.1%）单纯疱疹（1.4%）\n" +
                    "皮肤/皮下组织:痤疮（1.3%）\n" +
                    "呼吸系统:支气管炎（3.9%）\n" +
                    "3、特应性皮炎\n" +
                    "（1）发生率>1%\n" +
                    "1）乌帕替尼15 mg\n" +
                    "全身反应:头痛（6%）、发热（2%）、体重增加（2%）、疲劳（1%）\n" +
                    "免疫系统:单纯疱疹（生殖器疱疹、生殖器单纯疱疹、疱疹性皮炎、眼部疱疹、单纯疱疹、鼻疱疹、眼部单纯疱疹、疱疹病毒感染、口腔疱疹）（4%）、带状疱疹（带状疱疹和水痘）（2%）、流感样疾病（1%）、超敏反应（过敏反应、过敏性休克、血管性水肿、全身性剥脱性皮炎、药物超敏反应、眼睑水肿、面部水肿、超敏反应、眶周肿胀、咽部肿胀、面部肿胀、中毒性皮疹、I型超敏反应、荨麻疹）（2%）\n" +
                    "肌肉骨骼系统:肌痛（1%）\n" +
                    "呼吸系统：上呼吸道感染（URTI）（喉炎、病毒性喉炎、鼻咽炎、口咽痛、咽脓肿、咽炎、链球菌性咽炎、咽扁桃体炎、呼吸道感染、病毒性呼吸道感染、鼻炎、鼻咽炎、鼻窦炎、扁桃体炎、细菌性扁桃体炎、上呼吸道感染、病毒性咽炎,病毒性上呼吸道感染）（23%）、咳嗽（3%）、流感（2%）\n" +
                    "皮肤/皮下组织:痤疮（痤疮和痤疮样皮炎）（10%）、毛囊炎（2%）、疱疹性湿疹/卡波西水痘样疹\n" +
                    "消化系统:恶心（3%）、腹痛（腹痛和上腹痛）（3%）\n" +
                    "血液淋巴系统:中性粒细胞减少症（1%）\n" +
                    "其他:血肌酸磷酸激酶增加（5%）\n" +
                    "2）乌帕替尼30 mg\n" +
                    "全身反应:头痛（6%）、发热（2%）、体重增加（2%）、疲劳（2%）\n" +
                    "免疫系统:单纯疱疹（生殖器疱疹、生殖器单纯疱疹、疱疹性皮炎、眼部疱疹、单纯疱疹、鼻疱疹、眼部单纯疱疹、疱疹病毒感染、口腔疱疹）（8%）、带状疱疹（带状疱疹和水痘）（2%）、流感样疾病（2%）、超敏反应（过敏反应、过敏性休克、血管性水肿、全身性剥脱性皮炎、药物超敏反应、眼睑水肿、面部水肿、超敏反应、眶周肿胀、咽部肿胀、面部肿胀、中毒性皮疹、I型超敏反应、荨麻疹）（3%）\n" +
                    "肌肉骨骼系统:肌痛（2%）\n" +
                    "呼吸系统:上呼吸道感染（URTI）（喉炎、病毒性喉炎、鼻咽炎、口咽痛、咽脓肿、咽炎、链球菌性咽炎、咽扁桃体炎、呼吸道感染、病毒性呼吸道感染、鼻炎、鼻咽炎、鼻窦炎、扁桃体炎、细菌性扁桃体炎、上呼吸道感染、病毒性咽炎,病毒性上呼吸道感染）（25%）、咳嗽（3%）、流感（2%）\n" +
                    "皮肤/皮下组织:痤疮（痤疮和痤疮样皮炎）（16%）、毛囊炎（3%）、疱疹性湿疹/卡波西水痘样疹\n" +
                    "消化系统:恶心（3%）、腹痛（腹痛和上腹痛）（2%）\n" +
                    "血液淋巴系统:中性粒细胞减少症（2%）\n" +
                    "其他:血肌酸磷酸激酶增加（6%）\n" +
                    "（2）发生率<1%\n" +
                    "血液淋巴系统:贫血\n" +
                    "免疫系统:口腔念珠菌病\n" +
                    "呼吸系统:肺炎\n" +
                    "眼部:视网膜脱离\n" +
                    "4、溃疡性结肠炎\n" +
                    "（1）乌帕替尼45 mg\n" +
                    "1）发生率2%\n" +
                    "免疫系统:单纯疱疹（生殖器疱疹、生殖器单纯疹、疱疹性皮炎、眼部疱疹、单纯疱疹、鼻疱疹、眼部单纯疱疹、疱疹病毒感染、口腔疱疹）（2%）\n" +
                    "呼吸系统:上呼吸道感染（喉炎、病毒性喉炎、鼻咽炎、口咽痛、咽脓肿、咽炎、链球菌性咽炎、咽扁桃体炎、呼吸道感染、病毒性呼吸道感染、鼻炎、鼻咽炎、鼻窦炎、扁桃体炎、细菌性扁桃体炎、上呼吸道感染、病毒性咽炎,病毒性上呼吸道感染）（9%）\n" +
                    "皮肤/皮下组织:痤疮（痤疮和痤疮样皮炎）（6%）、皮疹（4%）、毛囊炎（2%）\n" +
                    "血液系统:中性粒细胞减少症（5%）、淋巴细胞减少症（3%）\n" +
                    "消化系统:肝酶升高（升高的肝酶由升高的ALT、AST、GGT、ALP、肝转氨酶、肝酶、胆红素、药物性肝损伤和胆汁淤积组成）（3%）\n" +
                    "其他:血肌酸磷酸激酶增加（5%）\n" +
                    "2）发生率<2%\n" +
                    "免疫系统:带状疱疹\n" +
                    "呼吸系统:肺炎\n" +
                    "（2）乌帕替尼30 mg\n" +
                    "发生率2%\n" +
                    "免疫系统:单纯疱疹（生殖器疱疹、生殖器单纯疱疹、疱疹性皮炎、眼部疱疹、单纯疱疹、鼻疱疹、眼部单纯疱疹、疱疹病毒感染、口腔疱疹）（3%）、带状疱疹（4%）\n" +
                    "呼吸系统:上呼吸道感染（喉炎、病毒性喉炎、咽炎、口咽痛、咽脓肿、咽炎、链球菌性咽炎、咽扁桃体炎、呼吸道感染、病毒性呼吸道感染炎、鼻咽炎、鼻窦炎、扁桃体炎、细菌性扁桃体炎、上呼吸道感染、病毒性咽炎,病毒性上呼吸道感染）（20%）、流感（3%）\n" +
                    "血液淋巴系统:中性粒细胞减少症（6%）";

            int score = calculateScore(input);
            System.out.println("最终得分: " + score);
        }

        public static int calculateScore(String input) {
            // 提取所有的百分比值
            Pattern pattern = Pattern.compile("(\\d+(\\.\\d+)?)%");
            Matcher matcher = pattern.matcher(input);

            double maxPercentage = 0.0;

            while (matcher.find()) {
                double percentage = Double.parseDouble(matcher.group(1));
                if (percentage > maxPercentage) {
                    maxPercentage = percentage;
                }
            }

            // 根据评分规则打分
            if (maxPercentage >= 10) {
                return 1;
            } else if (maxPercentage >= 1) {
                return 2;
            } else if (maxPercentage == 0) {
                return 0;
            } else {
                return 3; // 默认情况下返回3分
            }
        }


}
