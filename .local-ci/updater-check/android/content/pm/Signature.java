package android.content.pm;
public class Signature {
    private final String value;
    public Signature(String value){ this.value = value; }
    public boolean equals(Object other){ return other instanceof Signature && value.equals(((Signature)other).value); }
    public int hashCode(){ return value.hashCode(); }
    public String toCharsString(){ return value; }
}