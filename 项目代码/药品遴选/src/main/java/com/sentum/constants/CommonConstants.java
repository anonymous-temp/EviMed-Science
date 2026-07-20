package com.sentum.constants;

/**
 * @Description:
 */
public class CommonConstants {
    
    
    /*********
    *  result
    **********/
    public static final boolean BOOLEAN_FALSE = false;

    public static final boolean BOOLEAN_TRUE = true;
    
    /*********
    *  string
    **********/
    public static final String SPOT = ".";
    
    /*********
    * one - nine 
    **********/
    public static final int ZERO = 0;
    public static final int ONE = 1;
    public static final int TWO = 2;
    public static final int THOUSAND = 1000;

    /*********
    * guava retry
    **********/
    public static final int TRANSMISSION_RETRY_ATTEMPT = 2;
    public static final int TRANSMISSION_RETRY_ATTEMPT_SIX = 6;
    
    /*********
    *  redis key
    **********/
    public static final String DISEASE = "disease:";
    public static final String DRUG = "drug:";
    
    /*********
    *  language
    **********/
    public static final String LANGUAGE_EN = "en";
    public static final String LANGUAGE_ZH = "zh";
    
    /*********
    *  yes or no
    **********/
    public static final String YES = "本品为原研药品。";
    public static final String NO = "否";

    /*********
    *  redis key
    **********/
    public static final String VARIOUS_SCORE = "variousScore";


    /********
     * 合理用药表名
     */
    public static final String REASONABLE_DRUG_TABLE_NAME = "evaluation_medicine";
}
