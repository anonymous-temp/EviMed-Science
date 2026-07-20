package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HttpRequest;
import cn.hutool.http.HttpResponse;
import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.dto.PaperAndGuideIncludeDTO;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.pojo.info.WordStatus;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang3.StringUtils;
import org.apache.http.HttpHeaders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/5/30
 */
@Component
public class FeignAlternativeUtils {

    private final FineScreenFeign fineScreenFeign;

    @Autowired
    public FeignAlternativeUtils(FineScreenFeign fineScreenFeign) {
        this.fineScreenFeign = fineScreenFeign;
    }
    
    public List<String> paperAndGuideInclude(PaperAndGuideIncludeDTO guideIncludeDTO) {
        // 本地环境
        return fineScreenFeign.paperMix(JSON.parseObject(JSON.toJSONString(guideIncludeDTO), JSONObject.class));
//        // 线上环境
//        String requestForPaperInclude = getRequestForPaperInclude(guideIncludeDTO);
//        return JSON.parseObject(requestForPaperInclude, new TypeReference<List<String>>() {});
    }

   

    public String getRequestForPaperInclude(PaperAndGuideIncludeDTO guideIncludeDTO) {
        String userUrl = "https://research.evimed.com/api-evimed/FineScreenController/mix-search/paper-mix";
        HttpRequest post = HttpUtil.createPost(userUrl);
        post.setConnectionTimeout(60000);
        post.setReadTimeout(60000);
        post.header(HttpHeaders.CONTENT_TYPE, "application/json");
        post.body(JSONObject.toJSONString(guideIncludeDTO));
        post.header("token", "1d9a05461f8504d299421a74e3501fedd");
        HttpResponse execute = post.execute();
        return execute.body();
    }

    public String getRequestForDrugSafeInfoZx(Condition condition) {
        String userUrl = "https://research.evimed.com/api-evimed/evidence-api/adverse-api/drug-safe-info-zx";
        HttpRequest post = HttpUtil.createPost(userUrl);
        post.setConnectionTimeout(60000);
        post.setReadTimeout(60000);
        post.header(HttpHeaders.CONTENT_TYPE, "application/json");
        post.body(JSONObject.toJSONString(condition));
        post.header("token", "1d9a05461f8504d299421a74e3501fedd");
        HttpResponse execute = post.execute();
        return execute.body();
    }

    public String createSearchQuery(Condition condition) {
        List<Drug> drugs = condition.getDrugs();
        List<Disease> diseases = condition.getDiseases();
        List<InterventionAndOutcome> interventions = condition.getInterventions();
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();

        StringBuilder picosearchQuery = new StringBuilder();
        // i
        if (CollectionUtils.isNotEmpty(drugs)) {
            String drugSearch = drugs.stream().map(Drug::getWord).collect(Collectors.joining("联合"));
            picosearchQuery.append(drugSearch);
        }

        // p
        if (CollectionUtils.isNotEmpty(diseases)) {
            String diseaseSearch = diseases.stream().map(Disease::getWord).collect(Collectors.joining("合并"));
            if (StringUtils.isNotBlank(picosearchQuery.toString())) {
                picosearchQuery.append("治疗").append(diseaseSearch);
            } else {
                picosearchQuery.append(diseaseSearch);
            }
        }

        // c
        if (CollectionUtils.isNotEmpty(interventions)) {
            String interventionAndOutcomeSearch = interventions.stream().map(InterventionAndOutcome::getWord).collect(Collectors.joining("联合"));
            picosearchQuery.append("干预措施为：").append(interventionAndOutcomeSearch);
        }

        // o
        if (CollectionUtils.isNotEmpty(outcomes)) {
            String interventionAndOutcomeSearch = outcomes.stream().map(InterventionAndOutcome::getWord).collect(Collectors.joining("联合"));
            picosearchQuery.append("结局指标为：").append(interventionAndOutcomeSearch);
        }

        return picosearchQuery.toString();
    }

    public List<List<String>> assemblySynonym(Condition condition) {
        List<List<String>> wordList = new ArrayList<>();
        if (Objects.nonNull(condition)) {
            List<Drug> drugs = condition.getDrugs();
            if (CollectionUtils.isNotEmpty(drugs)) {
                for (Drug drug : drugs) {
                    List<String> currList = new ArrayList<>();
                    String word = drug.getWord();
                    String zhWord = drug.getZhWord();
                    List<WordStatus> zhSynonym = drug.getZhSynonym();
                    String enWord = drug.getEnWord();
                    List<WordStatus> enSynonym = drug.getEnSynonym();
                    List<WordStatus> otherSynonym = drug.getOtherSynonym();
                    String expandSynonym = drug.getExpandSynonym();
                    if (StringUtils.isNotBlank(word)) currList.add(word);
                    if (StringUtils.isNotBlank(zhWord)) currList.add(zhWord);
                    if (StringUtils.isNotBlank(enWord)) currList.add(enWord);
                    currList.addAll(zhSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.addAll(enSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.addAll(otherSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.add(expandSynonym);
                    currList = currList.stream().filter(StrUtil::isNotBlank).distinct().collect(Collectors.toList()); // 去重判空
                    wordList.add(currList);
                }
            }

            List<Disease> diseases = condition.getDiseases();
            if (CollectionUtils.isNotEmpty(diseases)) {
                for (Disease disease : diseases) {
                    List<String> currList = new ArrayList<>();
                    String word = disease.getWord();
                    String zhWord = disease.getZhWord();
                    List<WordStatus> zhSynonym = disease.getZhSynonym();
                    String enWord = disease.getEnWord();
                    List<WordStatus> enSynonym = disease.getEnSynonym();
                    List<WordStatus> otherSynonym = disease.getOtherSynonym();
                    String expandSynonym = disease.getExpandSynonym();
                    if (StringUtils.isNotBlank(word)) currList.add(word);
                    if (StringUtils.isNotBlank(zhWord)) currList.add(zhWord);
                    if (StringUtils.isNotBlank(enWord)) currList.add(enWord);
                    currList.addAll(zhSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.addAll(enSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.addAll(otherSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.add(expandSynonym);
                    currList = currList.stream().filter(StrUtil::isNotBlank).distinct().collect(Collectors.toList()); // 去重判空
                    wordList.add(currList);
                }
            }
        }
        return wordList;
    }
}
