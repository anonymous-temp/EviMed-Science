package com.sentum.evidencecomprehensive.service;

import cn.hutool.core.collection.CollUtil;
import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import com.sentum.evidencecomprehensive.domain.es.PaperIndex;
import org.elasticsearch.common.lucene.search.function.CombineFunction;
import org.elasticsearch.common.lucene.search.function.FunctionScoreQuery;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.index.query.functionscore.FieldValueFactorFunctionBuilder;
import org.elasticsearch.index.query.functionscore.FunctionScoreQueryBuilder;
import org.elasticsearch.index.query.functionscore.ScriptScoreFunctionBuilder;
import org.elasticsearch.script.Script;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.mapping.IndexCoordinates;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/12/16
 */

@Service
public class EsAISearchService {

    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;

    public List<Map<String, String>> getGuideEvidenceByTitleAnd(Integer pageSize, List<String> drugSynonym, List<String> diseaseSynonym) {
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder titleQueryBuilderDrug = new BoolQueryBuilder();

        if (CollUtil.isNotEmpty(drugSynonym)) {
            drugSynonym.forEach(synonym -> titleQueryBuilderDrug.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            boolQueryBuilder.must().add(titleQueryBuilderDrug);
        }

        BoolQueryBuilder titleQueryBuilderDisease = new BoolQueryBuilder();
        if (CollUtil.isNotEmpty(diseaseSynonym)) {
            List<String> wipeDiseaseSynonym = diseaseSynonym.stream().filter(synonym -> synonym.contains(",") || synonym.contains(" ")).map(synonym -> synonym.replaceAll("[\\\\s,]", "")).collect(Collectors.toList());
            if (CollUtil.isNotEmpty(wipeDiseaseSynonym)) {
                wipeDiseaseSynonym.forEach(synonym -> titleQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            }
            diseaseSynonym.forEach(synonym -> titleQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            boolQueryBuilder.must().add(titleQueryBuilderDisease);
        }
        NativeSearchQuery nativeSearchQuery;

        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(boolQueryBuilder, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setMaxResults(pageSize);
        SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);

        List<Map<String, String>> knowledge = new ArrayList<>();
        List<SearchHit<GuideIndex>> searchHits = search.getSearchHits();
        if (CollUtil.isNotEmpty(searchHits)) {
            searchHits.stream().map(SearchHit::getContent).forEach(guideIndex -> {
                Map<String, String> inner = new HashMap<>();
                inner.put("id", guideIndex.getId());
                SearchHit<GuideIndex> guideBlockIndex = elasticsearchRestTemplate.searchOne(new NativeSearchQuery(QueryBuilders.termQuery("guideId", guideIndex.getId())), GuideIndex.class, IndexCoordinates.of("guide_block_index"));
                String block = "";
                if (Objects.nonNull(guideBlockIndex)) {
                    block = guideBlockIndex.getContent().getBlock();
                }
                inner.put("title", guideIndex.getTitle());
                inner.put("text", block);
                knowledge.add(inner);
            });
        }

        return knowledge;
    }

    public List<Map<String, String>> getGuideEvidenceByTextAnd(Integer pageSize, List<String> drugSynonym, List<String> diseaseSynonym) {
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder textQueryBuilderDrug = new BoolQueryBuilder();

        if (CollUtil.isNotEmpty(drugSynonym)) {
            drugSynonym.forEach(synonym -> textQueryBuilderDrug.should().add(QueryBuilders.matchPhraseQuery("block", synonym)));
            boolQueryBuilder.must().add(textQueryBuilderDrug);
        }

        BoolQueryBuilder textQueryBuilderDisease = new BoolQueryBuilder();
        if (CollUtil.isNotEmpty(diseaseSynonym)) {
            List<String> wipeDiseaseSynonym = diseaseSynonym.stream().filter(synonym -> synonym.contains(",") || synonym.contains(" ")).map(synonym -> synonym.replaceAll("[\\\\s,]", "")).collect(Collectors.toList());
            if (CollUtil.isNotEmpty(wipeDiseaseSynonym)) {
                wipeDiseaseSynonym.forEach(synonym -> textQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("block", synonym)));
            }
            diseaseSynonym.forEach(synonym -> textQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("block", synonym)));
            boolQueryBuilder.must().add(textQueryBuilderDisease);
        }

        NativeSearchQuery nativeSearchQuery;

        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(boolQueryBuilder, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        nativeSearchQuery.setTrackScores(true);
        nativeSearchQuery.setMaxResults(pageSize);
        SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class, IndexCoordinates.of("guide_block_index"));

        List<Map<String, String>> knowledge = new ArrayList<>();
        List<SearchHit<GuideIndex>> searchHits = search.getSearchHits();
        if (CollUtil.isNotEmpty(searchHits)) {
            searchHits.stream().map(SearchHit::getContent).forEach(guideIndex -> {
                Map<String, String> inner = new HashMap<>();
                inner.put("id", guideIndex.getGuideId());
                inner.put("title", guideIndex.getTitle());
                inner.put("text", guideIndex.getBlock());
                knowledge.add(inner);
            });
        }

        return knowledge;
    }

    public List<Map<String, String>> getGuideEvidenceTitleOr(Integer pageSize, List<String> drugSynonym, List<String> diseaseSynonym) {
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder titleQueryBuilderDrug = new BoolQueryBuilder();

        if (CollUtil.isNotEmpty(drugSynonym)) {
            drugSynonym.forEach(synonym -> titleQueryBuilderDrug.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            boolQueryBuilder.should().add(titleQueryBuilderDrug);
        }

        BoolQueryBuilder titleQueryBuilderDisease = new BoolQueryBuilder();
        if (CollUtil.isNotEmpty(diseaseSynonym)) {
            List<String> wipeDiseaseSynonym = diseaseSynonym.stream().filter(synonym -> synonym.contains(",") || synonym.contains(" ")).map(synonym -> synonym.replaceAll("[\\\\s,]", "")).collect(Collectors.toList());
            if (CollUtil.isNotEmpty(wipeDiseaseSynonym)) {
                wipeDiseaseSynonym.forEach(synonym -> titleQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            }
            diseaseSynonym.forEach(synonym -> titleQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            boolQueryBuilder.should().add(titleQueryBuilderDisease);
        }

        NativeSearchQuery nativeSearchQuery;

        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(boolQueryBuilder, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

        nativeSearchQuery.setTrackScores(true);
        nativeSearchQuery.setMaxResults(pageSize);
        SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);

        List<Map<String, String>> knowledge = new ArrayList<>();
        List<SearchHit<GuideIndex>> searchHits = search.getSearchHits();
        if (CollUtil.isNotEmpty(searchHits)) {
            searchHits.stream().map(SearchHit::getContent).forEach(guideIndex -> {
                Map<String, String> inner = new HashMap<>();
                inner.put("id", guideIndex.getId());
                SearchHit<GuideIndex> guideBlockIndex = elasticsearchRestTemplate.searchOne(new NativeSearchQuery(QueryBuilders.termQuery("guideId", guideIndex.getId())), GuideIndex.class, IndexCoordinates.of("guide_block_index"));
                String block = "";
                if (Objects.nonNull(guideBlockIndex)) {
                    block = guideBlockIndex.getContent().getBlock();
                }
                inner.put("title", guideIndex.getTitle());
                inner.put("text", block);
                knowledge.add(inner);
            });
        }

        return knowledge;
    }

    public List<Map<String, String>> getGuideEvidenceTextOr(Integer pageSize, List<String> drugSynonym, List<String> diseaseSynonym) {
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder textQueryBuilderDrug = new BoolQueryBuilder();

        if (CollUtil.isNotEmpty(drugSynonym)) {
            drugSynonym.forEach(synonym -> textQueryBuilderDrug.should().add(QueryBuilders.matchPhraseQuery("block", synonym)));
            boolQueryBuilder.should().add(textQueryBuilderDrug);
        }

        BoolQueryBuilder textQueryBuilderDisease = new BoolQueryBuilder();
        if (CollUtil.isNotEmpty(diseaseSynonym)) {
            List<String> wipeDiseaseSynonym = diseaseSynonym.stream().filter(synonym -> synonym.contains(",") || synonym.contains(" ")).map(synonym -> synonym.replaceAll("[\\\\s,]", "")).collect(Collectors.toList());
            if (CollUtil.isNotEmpty(wipeDiseaseSynonym)) {
                wipeDiseaseSynonym.forEach(synonym -> textQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("block", synonym)));
            }
            diseaseSynonym.forEach(synonym -> textQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("block", synonym)));
            boolQueryBuilder.should().add(textQueryBuilderDisease);
        }

        NativeSearchQuery nativeSearchQuery;

        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(boolQueryBuilder, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

        nativeSearchQuery.setTrackScores(true);
        nativeSearchQuery.setMaxResults(pageSize);
        SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class, IndexCoordinates.of( "guide_block_index"));

        List<Map<String, String>> knowledge = new ArrayList<>();
        List<SearchHit<GuideIndex>> searchHits = search.getSearchHits();
        if (CollUtil.isNotEmpty(searchHits)) {
            searchHits.stream().map(SearchHit::getContent).forEach(guideIndex -> {
                Map<String, String> inner = new HashMap<>();
                inner.put("id", guideIndex.getGuideId());
                inner.put("title", guideIndex.getTitle());
                inner.put("text", guideIndex.getBlock());
                knowledge.add(inner);
            });
        }

        return knowledge;
    }

    public List<Map<String, String>> getLiteratureEvidence(Integer pageSize, List<String> drugSynonym, List<String> diseaseSynonym) {
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder titleAndSummaryQueryBuilderDrug = new BoolQueryBuilder();

        if (CollUtil.isNotEmpty(drugSynonym)) {
            drugSynonym.forEach(synonym -> titleAndSummaryQueryBuilderDrug.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            drugSynonym.forEach(synonym -> titleAndSummaryQueryBuilderDrug.should().add(QueryBuilders.matchPhraseQuery("summary", synonym)));
            boolQueryBuilder.must().add(titleAndSummaryQueryBuilderDrug);
        }

        BoolQueryBuilder titleAndSummaryQueryBuilderDisease = new BoolQueryBuilder();
        if (CollUtil.isNotEmpty(diseaseSynonym)) {
            diseaseSynonym.forEach(synonym -> titleAndSummaryQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            diseaseSynonym.forEach(synonym -> titleAndSummaryQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("summary", synonym)));
            boolQueryBuilder.must().add(titleAndSummaryQueryBuilderDisease);
        }
        
        NativeSearchQuery nativeSearchQuery;
        String scriptStr = "def baseScore = Math.log1p(_score + 1) * 0.5; def literatureScore = 50; if(doc['isIncomplete'].value != null && doc['isIncomplete'].value == 1) { literatureScore -= 50; } return baseScore + literatureScore;";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(boolQueryBuilder, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        nativeSearchQuery.setMaxResults(pageSize);
        SearchHits<PaperIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class);
        List<SearchHit<PaperIndex>> searchHits = search.getSearchHits();
        List<Map<String, String>> knowledge = new ArrayList<>();
        if (CollUtil.isNotEmpty(searchHits)) {
            searchHits.stream().map(SearchHit::getContent).forEach(guideIndex -> {
                Map<String, String> inner = new HashMap<>();
                inner.put("id", guideIndex.getId());
                inner.put("title", guideIndex.getTitle());
                inner.put("summary", guideIndex.getSummary());
                knowledge.add(inner);
            });
        }
        return knowledge;
    }

    private static FunctionScoreQueryBuilder getFunctionScoreQueryBuilder(SearchHit<PaperIndex> paperIndexSearchHit, BoolQueryBuilder boolQueryBuilder) {
        float maxScore = paperIndexSearchHit.getScore();
        //默认排序
        //String scriptStr = "double jcr=doc['jcr'].size()==0?0:doc['jcr'].getValue();int year=doc['year'].size()==0?1900:Integer.parseInt(doc['year'].getValue()=='' || doc['year'].getValue()=='unkn' ?'1990':doc['year'].getValue());double score=_score;double year_ratio=1;if((year-2015)>0){year_ratio=year/2015+100}else{year_ratio=1} return ((1-500/(score+500))*100+(1-1/(Math.pow(2, jcr)+1))) * year_ratio;";
        String scriptStr = "double yearWeight=doc['yearWeight'].size()==0?0:doc['yearWeight'].getValue();double coreWeight=doc['coreWeight'].size()==0?0:doc['coreWeight'].getValue();double score=_score;double score_ratio=score/" + maxScore + ";return 0.5*score_ratio+0.3*yearWeight+0.2*coreWeight";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        return QueryBuilders.functionScoreQuery(boolQueryBuilder, scriptScoreFunctionBuilder);
    }

    public List<Map<String, String>> getGuideEvidenceTitleAndText(String title, String lowerLevel, boolean languageFlag, Integer pageSize, List<String> drugSynonym, List<String> diseaseSynonym) {
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder titleAndTextQueryBuilderDrug = new BoolQueryBuilder();

        if (CollUtil.isNotEmpty(drugSynonym)) {
            drugSynonym.forEach(synonym -> titleAndTextQueryBuilderDrug.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            drugSynonym.forEach(synonym -> titleAndTextQueryBuilderDrug.should().add(QueryBuilders.matchPhraseQuery("block", synonym)));
            boolQueryBuilder.must().add(titleAndTextQueryBuilderDrug);
        }

        BoolQueryBuilder titleAndTextQueryBuilderDisease = new BoolQueryBuilder();
        if (CollUtil.isNotEmpty(diseaseSynonym)) {
            diseaseSynonym.forEach(synonym -> titleAndTextQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("title", synonym)));
            diseaseSynonym.forEach(synonym -> titleAndTextQueryBuilderDisease.should().add(QueryBuilders.matchPhraseQuery("block", synonym)));
            boolQueryBuilder.must().add(titleAndTextQueryBuilderDisease);
        }

        NativeSearchQuery nativeSearchQuery;

        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(boolQueryBuilder, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

        nativeSearchQuery.setTrackScores(true);
        nativeSearchQuery.setMaxResults(pageSize);
        SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);

        List<Map<String, String>> knowledge = new ArrayList<>();
        List<SearchHit<GuideIndex>> searchHits = search.getSearchHits();
        if (CollUtil.isNotEmpty(searchHits)) {
            searchHits.stream().map(SearchHit::getContent).forEach(guideIndex -> {
                Map<String, String> inner = new HashMap<>();
                inner.put("id", guideIndex.getId());
                inner.put("title", guideIndex.getTitle());
                inner.put("text", String.join(";", guideIndex.getBlocks()));
                knowledge.add(inner);
            });
        }

        return knowledge;
    }

}
