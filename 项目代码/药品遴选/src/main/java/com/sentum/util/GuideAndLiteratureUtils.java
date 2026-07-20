package com.sentum.util;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.extra.spring.SpringUtil;
import com.alibaba.fastjson.JSONObject;
import com.sentum.feign.FineScreenFeign;
import com.sentum.feign.FormulaFeign;
import com.sentum.pojo.vo.GuideVO;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.IdsQueryBuilder;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.redis.core.RedisTemplate;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;


@Slf4j
public class GuideAndLiteratureUtils {

    private static FormulaFeign formulaFeign;


    private static FineScreenFeign fineScreenFeign;

    private static RedisTemplate redisTemplate;

    private static ElasticsearchRestTemplate elasticsearchRestTemplate;

    static {
        formulaFeign = SpringUtil.getBean(FormulaFeign.class);
        fineScreenFeign = SpringUtil.getBean(FineScreenFeign.class);
        redisTemplate = SpringUtil.getBean(RedisTemplate.class);
        elasticsearchRestTemplate = SpringUtil.getBean(ElasticsearchRestTemplate.class);
    }


//    /**
//     * 根据drugName药品名称和disease疾病去
//     *
//     * @param drugs    药品同义词
//     * @param drugName 药品名称
//     * @param diseases 疾病同义词
//     * @param disease  疾病名称
//     * @return 返回查询到的指南
//     */
//    public static List<GuideVO> queryGuideByDrugAndDisease(List<String> drugs, String drugName, List<String> diseases, String disease) {
//        long startTime =  System.currentTimeMillis();
//        /*BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
//        BoolQueryBuilder drugBoolQueryBuilder = QueryBuilders.boolQuery();
//        BoolQueryBuilder diseaseBoolQueryBuilder = QueryBuilders.boolQuery();
//        for(String drug : drugs) {
//            MultiMatchQueryBuilder drugMultiMatchQueryBuilder = QueryBuilders.multiMatchQuery(drug, "title","keywords","nrjs","pdf_txt");
//            drugMultiMatchQueryBuilder.field("title", 100f);
//            drugMultiMatchQueryBuilder.field("keywords", 50f);
//            drugMultiMatchQueryBuilder.field("nrjs", 20f);
//            drugMultiMatchQueryBuilder.field("pdf_txt", 1f);
//            drugMultiMatchQueryBuilder.operator(Operator.AND);
//            drugMultiMatchQueryBuilder.slop(0);
//            drugMultiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
//            drugBoolQueryBuilder.should().add(drugMultiMatchQueryBuilder);
//        }
//
//        for(String dis : diseases) {
//            MultiMatchQueryBuilder diseaseMultiMatchQueryBuilder = QueryBuilders.multiMatchQuery(dis, "title","keywords","nrjs","pdf_txt");
//            diseaseMultiMatchQueryBuilder.field("title", 100f);
//            diseaseMultiMatchQueryBuilder.field("keywords", 50f);
//            diseaseMultiMatchQueryBuilder.field("nrjs", 20f);
//            diseaseMultiMatchQueryBuilder.field("pdf_txt", 1f);
//            diseaseMultiMatchQueryBuilder.operator(Operator.AND);
//            diseaseMultiMatchQueryBuilder.slop(0);
//            diseaseMultiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
//            diseaseBoolQueryBuilder.should().add(diseaseMultiMatchQueryBuilder);
//        }
//        boolQueryBuilder.must().add(drugBoolQueryBuilder);
//        boolQueryBuilder.must().add(diseaseBoolQueryBuilder);
//        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);*/
//        //使用检索中心检索式格式进行检索
//        StringBuilder query = new StringBuilder();
//        ArrayList<String> strings = new ArrayList<>();
//
//        montageForPaper(query, drugs, "");
//        if (CollUtil.isNotEmpty(diseases)) {
//            query.append(" AND ");
//            montageForPaper(query, diseases, "");
//        }
//        //检索中台组装条件
////        JSONObject jsonObject = new JSONObject();
////        jsonObject.put("query", query.toString());
////        jsonObject.put("type", 2);
////        String retrievalStr = formulaFeign.retrieval(jsonObject);
//        JSONObject jsonObject = new JSONObject();
//        jsonObject.put("query", query.toString());
//        jsonObject.put("type", "2");
//        String retrievalStr = formulaFeign.retrieval(jsonObject);
//        JSONObject dataJason = new JSONObject();
//        // 获取当前时间
//        LocalDateTime now = LocalDateTime.now();
//        // 精确到小时的时间
////        LocalDateTime hourPrecision = now.truncatedTo(java.time.temporal.ChronoUnit.HOURS);
//        String screenId = SecurityUtil.getMd5(retrievalStr + System.currentTimeMillis());
//        dataJason.put("screenId", screenId);
//        dataJason.put("query", retrievalStr);
//        dataJason.put("searchQuery", drugName + "治疗" + disease);
//        dataJason.put("type", 2);
//        dataJason.put("status", 2);
//        ArrayList<List<String>> wordList = new ArrayList<>();
//        wordList.add(drugs);
//        wordList.add(diseases);
//        dataJason.put("wordList", wordList);
//        List<String> ids = fineScreenFeign.mixSearch(dataJason);
//        JSONObject blocks1 = fineScreenFeign.getBlocks(screenId);
//        log.info("block:{}", blocks1.toString());
//        log.info("查询到指南id{}", ids.toString());
//        try {
//            if (CollUtil.isNotEmpty(ids)) {
//                //如果查询到了,更新缓存
//                redisTemplate.opsForValue().set("evaluationId:" + drugName + "治疗" + disease, ids, 3, TimeUnit.DAYS);
//                redisTemplate.opsForValue().set("evaluationBlock:" + drugName + "治疗" + disease, blocks1, 3, TimeUnit.DAYS);
//            } else {
//                //如果无返回，使用上次查询到的指南
//                ids = (List<String>) redisTemplate.opsForValue().get("evaluationId:" + drugName + "治疗" + disease);
//                blocks1 = (JSONObject) redisTemplate.opsForValue().get("evaluationBlock:" + drugName + "治疗" + disease);
//                log.info("redis获取的id{}", ids.toString());
//            }
//            //可能没记录也没返回
//        } catch (Exception e) {
//            log.error("redis异常", e);
//        }
////        long begin = System.currentTimeMillis();
////        // 存储经过筛选并截取完的指南
//        List<GuideVO> guideVOList = new ArrayList<>();
//        for (int i = 0; i < ids.size(); i++) {
//            IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder();
//            idsQueryBuilder.ids().add(ids.get(i));
//            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
//            SearchHits<GuideVO> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideVO.class);
//            SearchHit<GuideVO> searchHit = search.getSearchHit(0);
//            GuideVO guideVO = searchHit.getContent();
////            List<String> blocks = guideVO.getBlocks();
//            log.info("title{}", guideVO.getTitle());
//            String o = blocks1.getString(ids.get(i));
//            if (StringUtils.isNotEmpty(o)) {
//                guideVO.setPdf_txt(o);
//            } else {
//                continue;
//            }
////        WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
////        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(wrapperQueryBuilder);
////        SearchHits<GuideVO> search = this.elasticsearchRestTemplate.search(nativeSearchQuery, GuideVO.class);
////        log.info("查询到指南{}篇", search.getTotalHits());
////        long begin = System.currentTimeMillis();
////        // 存储经过筛选并截取完的指南
////        List<GuideVO> guideVOList = new ArrayList<>();
////        for (SearchHit<GuideVO> guideVOSearchHit : search) {
////            GuideVO guideVO = guideVOSearchHit.getContent();
////            List<String> blocks = guideVO.getBlocks();
////            if (CollUtil.isNotEmpty(blocks)) {
////                // 对查询出来的指南进行分析  查询是药物和疾病两个关键词是否有在50个字符之内的指南
////              /*  pdfTxt = pdfTxt.replaceAll(" ", "");
////                List<String> mainInfo = getMainInfo_v2(pdfTxt, drugs, diseases);
////                if (CollectionUtil.isNotEmpty(mainInfo)) {
////                    StringBuilder stringBuilder = new StringBuilder();
////                    for (String s : mainInfo) {
////                        stringBuilder.append(s);
////                    }
////                    guideVO.setPdf_txt(stringBuilder.toString());
////                    guideVOList.add(guideVO);
////                }
////                */
////                Pattern patternDrugs = Pattern.compile(getRegex(drugs));
////                Pattern patternDiseases = Pattern.compile(getRegex(diseases));
////                StringBuilder stringBuilder = new StringBuilder();
////                ArrayList<String> blocks1 = new ArrayList<>();
////                for (String block : blocks) {
////                    Matcher matcherDrugs = patternDrugs.matcher(block);
////                    if (matcherDrugs.find()) {
////                        Matcher matcher = patternDiseases.matcher(block);
////                        if (matcher.find()) {
////                            stringBuilder.append(block).append("\n");
////                        }
////                    }
////                }
////                if (stringBuilder.length() > 0) {
////                    if (stringBuilder.length() > 2000) {
////                        stringBuilder.delete(2000, stringBuilder.length());
////                    }
////                    log.info("title{}", guideVO.getTitle());
////                    log.info("匹配到指南block{}", stringBuilder.toString());
////                    guideVO.setPdf_txt(stringBuilder.toString());
//            guideVOList.add(guideVO);
////                }
////            }
//            if (guideVOList.size() > 4) break;
//        }
//        long endTime = System.currentTimeMillis();
//     log.info("查询到指南{}篇,耗时{}ms", guideVOList.size(), endTime - startTime);
//        log.info("药{},疾病{}, 需要经过gpt分析的指南数量是{}", drugName, disease, guideVOList.size());
//        return guideVOList;
//    }


    private static void montageForPaper(StringBuilder query, List<String> inner, String type) {
        query.append("(");
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            if (StringUtils.isNotBlank(type)) {
                query.append(s).append("[").append(type).append("]").append(" OR ");
            } else {
                query.append(s).append(" OR ");
            }
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        if (StringUtils.isNotBlank(type)) {
            query.append(s).append("[").append(type).append("]");
        } else {
            query.append(s);
        }
        query.append(")");
    }

}
